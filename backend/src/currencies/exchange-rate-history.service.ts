import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource, IsNull } from "typeorm";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { withScopedDb } from "../common/db/scoped-db";
import { roundFxRate } from "../common/fx-entry.util";
import { EmptyWindowMemory } from "../common/time-series/history-fill";
import { FX_MAX_RATE_AGE_DAYS } from "../common/time-series/fx-rate-resolver";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";
import { tr } from "../i18n/translate";
import { codeOrderedPair } from "./canonical-rate.util";
import { Currency } from "./entities/currency.entity";
import {
  ExchangeRateService,
  directionlessPairKey,
  pairKeyHasCode,
} from "./exchange-rate.service";
import { FxProviderChain } from "./providers/fx-provider-chain";
import {
  GAP_FILL_BUDGET_MS,
  MAX_GAP_WINDOWS,
  planRateGapWindows,
  type RateGapWindow,
} from "./rate-gap-plan";

/**
 * One pair's row in `exchange_rate_coverage`, with `null` for "not established".
 *
 * `earliestAvailableDate` is a fact about the provider: the earliest date it is
 * known to carry a rate for the pair, which no retry moves.
 * `firstGapDate` is a fact about this deployment's own progress: the earliest
 * date whose gap has not yet been put to the provider. Keeping them apart is
 * what lets a fill skip both the years that cannot be filled and the years that
 * already have been, without confusing one for the other.
 */
interface PairCoverage {
  earliestAvailableDate: string | null;
  firstGapDate: string | null;
  /**
   * The earliest date any fill has planned over. `firstGapDate` may only be
   * trusted as far back as this: a reader whose own data now reaches further
   * back has years in front of the pointer that nothing has ever examined.
   */
  probedFrom: string | null;
}

/** How a window is named in the empty-window memory. */
function windowKey(window: RateGapWindow): string {
  return `${window.start}..${window.end}`;
}

/**
 * What the database already holds for one currency pair, in days.
 *
 * `earliestDate` and `latestDate` are `YYYY-MM-DD` or `null` when the pair has
 * no rows at all; `observations` counts calendar days, not rows. Rows written
 * before the pair was collapsed to one orientation still hold a day twice, and a
 * reader shown "512 observations" for 256 days would read that storage layout as
 * market data.
 */
export interface RateCoverage {
  from: string;
  to: string;
  earliestDate: string | null;
  latestDate: string | null;
  observations: number;
}

/**
 * The most dates one listing returns, newest first.
 *
 * Roughly eight years of daily observations. The listing is a scrollable panel
 * in a dialog, not an export, so it is bounded; what the bound leaves out is
 * reported (`truncated`) rather than quietly dropped, and `getCoverage` still
 * answers over every stored row, so the span a reader is told about is never
 * the capped one.
 */
export const STORED_RATE_ROW_CAP = 2000;

/** One stored observation, stated in the direction the reader asked about. */
export interface StoredRate {
  /** `YYYY-MM-DD`, through `TO_CHAR` rather than the DATE parser. */
  rateDate: string;
  /**
   * Units of `to` per 1 unit of `from`, or `null` where the stored row cannot
   * be stated in that direction at all: a row holding zero or a negative rate
   * inverts to infinity, which is an unknown, never a rate and never a zero.
   */
  rate: number | null;
  /** The provider slug the row carries; `null` for a row written without one. */
  source: string | null;
  /** The stored row is the other orientation and `rate` is its reciprocal. */
  inverted: boolean;
}

export interface StoredRateList {
  from: string;
  to: string;
  /** Newest date first, one entry per date. */
  rates: StoredRate[];
  /** The pair holds more dates than `limit`; the oldest are not listed. */
  truncated: boolean;
  limit: number;
}

/**
 * The outcome of one "fill the gaps" request.
 *
 * `usedFrom` is the first date the currency appears in the caller's own data
 * and `null` when it appears nowhere, which is the one case that fetches
 * nothing at all.
 *
 * `windowsPlanned` is every window the span needs, not just the ones this
 * request could reach. `windowsSkipped` are those the provider has already
 * answered with nothing, which cost no call and are not work left to do.
 * `windowsFetched` were asked for, and the `windowsUnanswered` among them are
 * counted again in `windowsRemaining`, together with the windows a bound never
 * reached.
 */
export interface RateGapFill {
  from: string;
  to: string;
  usedFrom: string | null;
  /** Today; the span the fill considers is `[usedFrom, spanEnd]`. */
  spanEnd: string;
  /**
   * Calendar days in the span no stored observation could answer at all, on
   * the 45-day carry-forward bound. Often zero while `sparseDays` is large: a
   * month-end-only history converts every date and prices almost none of them
   * on their own day.
   */
  unresolvableDays: number;
  /**
   * Calendar days in the span with no observation within ten days -- the
   * honest measure of how much of this history is missing, and the one the
   * windows are planned from.
   */
  sparseDays: number;
  windowsPlanned: number;
  windowsFetched: number;
  windowsSkipped: number;
  /** Fetched windows the provider did not answer at all. */
  windowsUnanswered: number;
  windowsRemaining: number;
  /** Observations persisted by this request. */
  stored: number;
  /** The pair's new coverage lower bound. */
  earliestDate: string | null;
  /**
   * The earliest date the provider is known to carry a rate for this pair,
   * whether this request established it or a previous one did. A statement
   * about the provider's history, not about a failure: asking again will not
   * change it, which is why it is kept in `exchange_rate_coverage` rather than
   * learned again on every press.
   */
  providerHasNothingBefore: string | null;
}

/**
 * Reading and deepening the stored FX history of one pair.
 *
 * The daily refresh writes today's spot rate and `backfillHistoricalRates`
 * skips any pair that already holds a row, so a pair's stored history usually
 * begins on the day the cron first ran. A report dated before that says
 * "Missing exchange rates: EUR->PLN 2026-01-01 to 2026-06-19" and there is
 * nothing the reader can do about it without admin rights. This is that door:
 * list what is stored, work out which dates no stored observation can answer,
 * and ask the provider for those.
 *
 * It is a sibling of `ExchangeRateService` rather than more of it because that
 * file is already past this repository's size ceiling; the provider call itself
 * is that service's `fillRateWindow`, reached through its public wrapper, so
 * there is exactly one place that talks to Yahoo about a rate window.
 *
 * **Concurrency.** The write is an idempotent upsert on the natural key
 * `(from_currency, to_currency, rate_date)` -- mechanism 4 of
 * `docs/concurrency-and-idempotency.md` -- so two concurrent fills of the same
 * pair converge rather than duplicate, and correctness needs nothing else.
 * `inFlight` below is therefore a *coalescer, not a guard*: it exists only so a
 * double-clicked button costs one provider call instead of two, and a replica
 * that has not seen the first click simply makes the call. It gates no row and
 * coordinates nothing across replicas, which is the same category as
 * `emptyWindows` beside it.
 *
 * `docs/specs/fx-history-gap-fill.md` is the contract.
 */
@Injectable()
export class ExchangeRateHistoryService {
  private readonly logger = new Logger(ExchangeRateHistoryService.name);

  /**
   * Fills currently running, keyed by caller and directionless pair.
   *
   * The caller is part of the key because the answer is about their data: the
   * span comes from their own accounts and the counts describe their gaps. Two
   * people sharing a reporting currency who press at the same moment would
   * otherwise both be handed the first one's `usedFrom` and a
   * `windowsRemaining: 0` that was never computed for the second. See the class
   * doc for why this coalesces rather than guards.
   */
  private readonly inFlight = new Map<string, Promise<RateGapFill>>();

  /**
   * Windows the provider answered with no rates, remembered for half an hour.
   *
   * A pair's history starts where it starts, so the window before it can never
   * be filled; without this, every press of the button re-asks for it. A cache
   * and not a guard, in the category `history-fill.ts` describes: losing an
   * entry costs a round trip and changes no row. It needs no provider-chain
   * scoping of its own: the chain is fixed for the life of the process, and
   * changing `FX_PROVIDERS` takes a restart, which starts this memory empty.
   * What the chain cannot see change is a coin's price symbol, so a pair the
   * chain reports uncarried is never remembered here, and a new symbol drops
   * the code's entries (`forgetEmptyWindowsFor`).
   */
  private readonly emptyWindows = new EmptyWindowMemory();

  constructor(
    private readonly dataSource: DataSource,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly fxProviders: FxProviderChain,
  ) {}

  /**
   * Forget the windows this process remembers as empty for every pair with
   * `code` on either side, here and in `ExchangeRateService`'s on-demand
   * memory. `CurrenciesService` calls it after a coin's price symbol is first
   * set or re-pointed, with the code's `exchange_rate_coverage` rows deleted
   * in the same transaction as the symbol: what was found empty under the old
   * symbol says nothing about the new one.
   *
   * Process-local, like the memories themselves: another replica keeps its
   * entries until they expire, at most `EMPTY_WINDOW_TTL_MS` (half an hour),
   * which costs a reader there a skipped window for that long and writes
   * nothing.
   */
  forgetEmptyWindowsFor(code: string): void {
    this.emptyWindows.forgetSubjects((pair) => pairKeyHasCode(pair, code));
    this.exchangeRateService.forgetEmptyRateWindowsFor(code);
  }

  /**
   * The running provider chain as `exchange_rate_coverage.providers` records
   * it: the ordered source slugs, joined with commas.
   *
   * Order is part of it on purpose. The chain answers a window from the first
   * carrying provider that has anything, so reordering changes which history a
   * fill sees just as adding or removing a provider does.
   */
  private providerFingerprint(): string {
    return this.fxProviders
      .describe()
      .map((provider) => provider.source)
      .join(",");
  }

  /**
   * The pair `code` forms with the caller's reporting currency, and the two
   * currencies in the order the rest of the UI names them.
   *
   * Refuses the same-currency pair: 1 is not a stored rate, so there is no
   * history to list and none to fill.
   */
  private async resolvePair(
    userId: string,
    code: string,
  ): Promise<{ from: string; to: string }> {
    const to = await resolveUserDefaultCurrency(this.dataSource, userId);
    if (code === to) {
      throw new BadRequestException(
        tr(
          "errors.currencies.sameCurrencyHistory",
          `${code} is your default currency; it has no exchange rate history`,
          { code },
        ),
      );
    }
    return { from: code, to };
  }

  /**
   * What is stored for `code` against the caller's reporting currency.
   *
   * Either stored direction counts as the one pair it is: a row under
   * `PLN->EUR` is evidence about `EUR->PLN` on that date too, which is why a new
   * row is stored in one orientation only (INV-FX-003) and why this still reads
   * both -- rows written before that change are still there. Dates come back
   * through `TO_CHAR` rather than the entity transformer, per the backend's
   * raw-SELECT rule.
   */
  async getCoverage(userId: string, code: string): Promise<RateCoverage> {
    const { from, to } = await this.resolvePair(userId, code);
    return this.readCoverage(from, to);
  }

  private async readCoverage(from: string, to: string): Promise<RateCoverage> {
    const rows: Array<{
      earliest: string | null;
      latest: string | null;
      observations: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT TO_CHAR(MIN(rate_date), 'YYYY-MM-DD') AS earliest,
                TO_CHAR(MAX(rate_date), 'YYYY-MM-DD') AS latest,
                COUNT(DISTINCT rate_date) AS observations
           FROM exchange_rates
          WHERE (from_currency = $1 AND to_currency = $2)
             OR (from_currency = $2 AND to_currency = $1)`,
        [from, to],
      ),
    );
    const row = rows[0];
    return {
      from,
      to,
      earliestDate: row?.earliest ?? null,
      latestDate: row?.latest ?? null,
      observations: Number(row?.observations ?? 0),
    };
  }

  /**
   * Every stored rate for `code` against the caller's reporting currency,
   * newest date first, one entry per date.
   *
   * One entry per date is structural rather than a property of an ordering:
   * the rows are grouped by date and each group yields the canonical
   * orientation's row, which is the one every writer maintains and the one the
   * pending contract migration keeps where a pre-collapse date is held twice
   * and the two disagree. Grouping also keeps this off the newest-rate path
   * that `fx-rate.one-door.spec.ts` guards; this is a listing, not a lookup,
   * and a date's rate for a calculation still comes from `resolveFxRate`.
   */
  async getStoredRates(userId: string, code: string): Promise<StoredRateList> {
    const { from, to } = await this.resolvePair(userId, code);

    const rows: Array<{
      rate_date: string;
      from_currency: string;
      rate: string | null;
      source: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT TO_CHAR(rate_date, 'YYYY-MM-DD') AS rate_date,
                (ARRAY_AGG(from_currency ORDER BY (from_currency < to_currency) DESC, id DESC))[1] AS from_currency,
                (ARRAY_AGG(rate ORDER BY (from_currency < to_currency) DESC, id DESC))[1] AS rate,
                (ARRAY_AGG(source ORDER BY (from_currency < to_currency) DESC, id DESC))[1] AS source
           FROM exchange_rates
          WHERE (from_currency = $1 AND to_currency = $2)
             OR (from_currency = $2 AND to_currency = $1)
          GROUP BY rate_date
          ORDER BY rate_date DESC
          LIMIT $3`,
        [from, to, STORED_RATE_ROW_CAP + 1],
      ),
    );

    const rates = rows.slice(0, STORED_RATE_ROW_CAP).map((row) => {
      const stored = Number(row.rate);
      const inverted = row.from_currency !== from;
      const usable = Number.isFinite(stored) && stored > 0;
      return {
        rateDate: row.rate_date,
        // The reciprocal is struck at the rate column's ten decimals, never at
        // money's four: `canonicalRateRow` inverts the same way, so a row read
        // back matches the row a fetch would have written.
        rate: usable ? (inverted ? roundFxRate(1 / stored) : stored) : null,
        source: row.source ?? null,
        inverted,
      };
    });

    return {
      from,
      to,
      rates,
      truncated: rows.length > STORED_RATE_ROW_CAP,
      limit: STORED_RATE_ROW_CAP,
    };
  }

  /**
   * The first date `code` appears in this user's own data, or `null`.
   *
   * Deliberately wider than `backfillHistoricalRates`' discovery, which filters
   * to open accounts, active securities and non-empty holdings because it is
   * priming rates for current positions. A history fill must include the years
   * a since-closed account was open and a since-sold holding was held, because
   * "net worth over time" and "portfolio value over time" still report them.
   *
   * An account or security with no postings still falls back to the row's own
   * creation date rather than dropping out: an account holding an opening
   * balance and nothing else is still reported by "net worth over time", and
   * answering "nothing of yours uses EUR" for one would leave a reader with no
   * way to fetch the rates their own balances need. The same fallback
   * `resolveInvestmentInception` uses for an account with neither ledger.
   *
   * Rows as EFFECTS: renders `it.status != 'VOID'`, because a void posting
   * records something that did not happen and so dates no use of the currency.
   *
   * `null` means no account and no security of this user's is denominated in
   * the currency, so no report of theirs can need the rate.
   */
  private async firstUseOfCurrency(
    userId: string,
    code: string,
  ): Promise<string | null> {
    // Rows as EFFECTS: both postings subqueries below render
    // `status != 'VOID'`, because a void row records something that did not
    // happen and so dates no use of the currency.
    const rows: Array<{ earliest: string | null }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT TO_CHAR(MIN(earliest), 'YYYY-MM-DD') AS earliest
             FROM (
               SELECT COALESCE(
                        LEAST(
                          (SELECT MIN(t.transaction_date)
                             FROM transactions t
                            WHERE t.account_id = a.id),
                          (SELECT MIN(it.transaction_date)
                             FROM investment_transactions it
                            WHERE it.account_id = a.id
                              AND ${investmentEffectStatusSql("it")})
                        ),
                        a.created_at::DATE
                      ) AS earliest
                 FROM accounts a
                WHERE a.user_id = $1
                  AND a.currency_code = $2
               UNION ALL
               -- Rows as EFFECTS here too: status != 'VOID'.
               SELECT COALESCE(
                        (SELECT MIN(it.transaction_date)
                           FROM investment_transactions it
                          WHERE it.security_id = s.id
                            AND ${investmentEffectStatusSql("it")}),
                        s.created_at::DATE
                      ) AS earliest
                 FROM securities s
                WHERE s.user_id = $1
                  AND s.currency_code = $2
             ) uses`,
          [userId, code],
        ),
    );
    return rows[0]?.earliest ?? null;
  }

  /**
   * The pair's observation dates from `from` onwards, in either orientation.
   *
   * The caller asks from `FX_MAX_RATE_AGE_DAYS` before the span, because an
   * observation that far ahead of the span's first day is what answers it.
   *
   * A non-positive stored rate is not an observation: `resolveFxRate` discards
   * it, so counting it here would plan no gap over the 45 days it appears to
   * cover while every report over them still refuses to convert.
   */
  private async storedDatesFrom(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<string[]> {
    const rows: Array<{ rate_date: string }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT DISTINCT TO_CHAR(rate_date, 'YYYY-MM-DD') AS rate_date
             FROM exchange_rates
            WHERE ((from_currency = $1 AND to_currency = $2)
                OR (from_currency = $2 AND to_currency = $1))
              AND rate > 0
              AND rate_date >= $3::DATE
              AND rate_date <= $4::DATE`,
          [from, to, start, end],
        ),
    );
    return rows.map((row) => row.rate_date);
  }

  /**
   * The pair as `exchange_rate_coverage` keys it: plain code order, which is
   * what the table's CHECK (`from_currency < to_currency`) refuses anything
   * but.
   *
   * A rate window answers a pair rather than a direction, so the row is the
   * same row whichever way round the reader's own question is put. It is
   * deliberately not the storage orientation of `exchange_rates`
   * (`isCanonicalOrientation`), which puts a coin first whichever code sorts
   * first: the coverage key is about which pair, never which direction, and a
   * key that followed `currencies.kind` would break the CHECK for a coin whose
   * code sorts after its fiat and orphan the row if a currency changed kind.
   * `directionlessPairKey` keys the same way (`codeOrderedPair`).
   */
  private static coverageKey(from: string, to: string): [string, string] {
    return codeOrderedPair(from, to);
  }

  /**
   * What is on record about the provider's history for this pair.
   *
   * All three dates are `null` until a fill has probed the pair. Read before
   * planning, because between them they say which part of the span is worth
   * planning at all: nothing before `earliestAvailableDate` exists to be
   * fetched, nothing between there and `firstGapDate` has been left unasked,
   * and `probedFrom` says how far back that second claim may be trusted.
   *
   * A row written under another provider chain -- including a `NULL` one,
   * written before the chain was recorded -- reads as all-`null`. What Yahoo
   * alone was found to carry says nothing about what Frankfurter does, and a
   * stale floor would hide history the running chain can supply.
   */
  private async readPairCoverage(
    from: string,
    to: string,
  ): Promise<PairCoverage> {
    const [first, second] = ExchangeRateHistoryService.coverageKey(from, to);
    const rows: Array<{
      earliest_available: string | null;
      first_gap: string | null;
      probed_from: string | null;
      providers: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT TO_CHAR(earliest_available_date, 'YYYY-MM-DD') AS earliest_available,
                TO_CHAR(first_gap_date, 'YYYY-MM-DD') AS first_gap,
                TO_CHAR(probed_from, 'YYYY-MM-DD') AS probed_from,
                providers
           FROM exchange_rate_coverage
          WHERE from_currency = $1
            AND to_currency = $2`,
        [first, second],
      ),
    );
    const row = rows[0];
    if (!row || row.providers !== this.providerFingerprint()) {
      return {
        earliestAvailableDate: null,
        firstGapDate: null,
        probedFrom: null,
      };
    }
    return {
      earliestAvailableDate: row.earliest_available ?? null,
      firstGapDate: row.first_gap ?? null,
      probedFrom: row.probed_from ?? null,
    };
  }

  /**
   * Record what this fill learned about the pair, forwards only.
   *
   * An idempotent upsert on the natural key -- mechanism 4 of
   * `docs/concurrency-and-idempotency.md` -- so two concurrent fills converge.
   * `GREATEST` ignores nulls in PostgreSQL, which is exactly the rule wanted
   * here: a column already set keeps its value against a `null`, an unset one
   * takes the new date, and neither ever moves backwards. A pointer that went
   * backwards would re-plan the years the press before it had just answered.
   *
   * The merge holds only within one provider chain. A row recorded under a
   * different chain (or none) has its three dates **replaced** by this write's,
   * and takes this chain's fingerprint: merging would carry the stale floor
   * straight through the first write after a change to `FX_PROVIDERS`.
   * `IS DISTINCT FROM` is what makes a `NULL` fingerprint count as different.
   */
  private async recordPairCoverage(
    from: string,
    to: string,
    coverage: PairCoverage,
  ): Promise<void> {
    if (
      !coverage.earliestAvailableDate &&
      !coverage.firstGapDate &&
      !coverage.probedFrom
    ) {
      return;
    }
    const [first, second] = ExchangeRateHistoryService.coverageKey(from, to);
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO exchange_rate_coverage
                (from_currency, to_currency, earliest_available_date,
                 first_gap_date, probed_from, providers)
         VALUES ($1, $2, $3::DATE, $4::DATE, $5::DATE, $6)
         ON CONFLICT (from_currency, to_currency) DO UPDATE SET
           earliest_available_date = CASE
             WHEN exchange_rate_coverage.providers IS DISTINCT FROM EXCLUDED.providers
               THEN EXCLUDED.earliest_available_date
             ELSE GREATEST(
               exchange_rate_coverage.earliest_available_date,
               EXCLUDED.earliest_available_date)
           END,
           first_gap_date = CASE
             WHEN exchange_rate_coverage.providers IS DISTINCT FROM EXCLUDED.providers
               THEN EXCLUDED.first_gap_date
             ELSE GREATEST(
               exchange_rate_coverage.first_gap_date,
               EXCLUDED.first_gap_date)
           END,
           probed_from = CASE
             WHEN exchange_rate_coverage.providers IS DISTINCT FROM EXCLUDED.providers
               THEN EXCLUDED.probed_from
             ELSE LEAST(
               exchange_rate_coverage.probed_from,
               EXCLUDED.probed_from)
           END,
           providers = EXCLUDED.providers,
           updated_at = CURRENT_TIMESTAMP`,
        [
          first,
          second,
          coverage.earliestAvailableDate,
          coverage.firstGapDate,
          coverage.probedFrom,
          this.providerFingerprint(),
        ],
      ),
    );
  }

  /**
   * Fetch and store the rates the caller's reports are short of, for one pair.
   *
   * The span is the first date the currency is used through today, and the work
   * is the windows inside it that no stored observation can answer -- not the
   * whole span, because a fetched window overwrites every row it covers.
   *
   * Three outcomes the caller has to be able to tell apart: rates were stored;
   * the provider answered with nothing, which is a statement about its history
   * and will not change on a retry; or the provider did not answer, which is a
   * 503 so the UI can say "try later" rather than "there is no data".
   */
  async fillRateGaps(userId: string, code: string): Promise<RateGapFill> {
    const { from, to } = await this.resolvePair(userId, code);
    const key = `${userId}|${directionlessPairKey(from, to)}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const attempt = this.runGapFill(userId, from, to).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async runGapFill(
    userId: string,
    from: string,
    to: string,
  ): Promise<RateGapFill> {
    const spanEnd = todayYMD();
    const usedFrom = await this.firstUseOfCurrency(userId, from);
    const before = await this.readCoverage(from, to);

    const nothingToDo = (extra: Partial<RateGapFill> = {}): RateGapFill => ({
      from,
      to,
      usedFrom,
      spanEnd,
      unresolvableDays: 0,
      sparseDays: 0,
      windowsPlanned: 0,
      windowsFetched: 0,
      windowsSkipped: 0,
      windowsUnanswered: 0,
      windowsRemaining: 0,
      stored: 0,
      earliestDate: before.earliestDate,
      providerHasNothingBefore: null,
      ...extra,
    });

    // Nothing of this user's is denominated in the currency, so no report of
    // theirs needs the rate. Fetching a history nobody reads is the cost this
    // check exists to avoid.
    if (!usedFrom) return nothingToDo();
    if (usedFrom > spanEnd) return nothingToDo();

    // The span opens at the latest of three dates, none of which is worth
    // planning before: the reader's own first use of the currency, the day the
    // provider's history starts, and the point the last fill got to. Without
    // the second, a pair carrying nothing before 2003 re-plans every year back
    // to 1996 on every press; without the third, a stretch the provider has
    // already answered as well as it can is re-asked for forever, which is what
    // a history it can only answer sparsely would otherwise cost.
    const coverage = await this.readPairCoverage(from, to);
    // The resume pointer is stood down for one press when the reader's own data
    // now reaches back behind everything that has ever been planned over --
    // importing older transactions is how that happens. Without this the
    // pointer would sit in front of years nothing has examined and hide them
    // for good, which is a worse failure than the re-fetching it prevents.
    const resumeApplies =
      !!coverage.probedFrom && usedFrom >= coverage.probedFrom;
    const spanStart = [
      coverage.earliestAvailableDate,
      resumeApplies ? coverage.firstGapDate : null,
    ].reduce<string>(
      (latest, candidate) =>
        candidate && candidate > latest ? candidate : latest,
      usedFrom,
    );
    if (spanStart > spanEnd) {
      return nothingToDo({
        providerHasNothingBefore: coverage.earliestAvailableDate,
      });
    }

    const stored = await this.storedDatesFrom(
      from,
      to,
      addDaysYMD(spanStart, -FX_MAX_RATE_AGE_DAYS),
      spanEnd,
    );
    const plan = planRateGapWindows(stored, spanStart, spanEnd);
    if (plan.windows.length === 0) {
      // Everything from here to today is either dense enough already or has
      // been asked for. Record that, so tomorrow's press plans the one new day
      // rather than the whole span again.
      await this.recordPairCoverage(from, to, {
        earliestAvailableDate: null,
        firstGapDate: spanEnd,
        probedFrom: spanStart,
      });
      return nothingToDo({
        unresolvableDays: plan.unresolvableDays,
        sparseDays: plan.sparseDays,
        providerHasNothingBefore: coverage.earliestAvailableDate,
      });
    }

    // The budget is spent on windows that might actually answer. A window the
    // provider has already said it has nothing for cannot be filled by asking
    // again, so counting it against the cap would let a pair whose history
    // starts long after the reader's data does consume every press on the same
    // dead years and fetch nothing at all.
    const key = directionlessPairKey(from, to);
    const live = plan.windows.filter(
      (window) => !this.emptyWindows.has(key, windowKey(window)),
    );
    const skipped = plan.windows.length - live.length;
    const due = live.slice(0, MAX_GAP_WINDOWS);

    // `exchange_rates` is shared reference data (it is RLS-exempt for that
    // reason), so the user id goes in the log line rather than in the row.
    this.logger.log(
      `User ${userId} filling ${due.length} of ${plan.windows.length} ${from}->${to} ` +
        `rate gap window(s) over ${spanStart} to ${spanEnd} ` +
        `(${plan.sparseDays} days without a nearby rate, ` +
        `${plan.unresolvableDays} unanswerable, ${skipped} known empty` +
        `${
          coverage.earliestAvailableDate
            ? `, provider history starts ${coverage.earliestAvailableDate}`
            : ""
        })`,
    );

    const outcome = await this.fetchWindows(from, to, due);

    if (outcome.uncarried) {
      // No provider that may be asked carries the pair, so nobody was asked
      // and nothing is known about the provider's history: no coverage row
      // and no empty window, or the symbol the reader maps next would find
      // every past window already written off.
      throw await this.uncarriedPair(from, to);
    }

    if (
      outcome.fetched > 0 &&
      outcome.unanswered === outcome.fetched &&
      outcome.stored === 0
    ) {
      // Every window this request actually asked for failed to answer, and
      // nothing was written: that is an outage, not an absence. A request that
      // asked for nothing -- because every window is already known empty -- is
      // neither, and says so with its counts.
      this.logger.warn(
        `Rate gap fill ${from}->${to} got no answer from the provider`,
      );
      throw new ServiceUnavailableException(
        tr(
          "errors.currencies.rateProviderUnavailable",
          "The exchange rate provider did not answer. Please try again later.",
        ),
      );
    }

    const after =
      outcome.stored > 0 ? await this.readCoverage(from, to) : before;

    // What this request established, read after the fetch so the windows it
    // just found empty count alongside the ones it skipped. Both dates are
    // written down so the next press opens its span past them: the first
    // because no retry can fill what the provider does not have, the second
    // because re-asking for a window already answered buys nothing.
    const emptyRunEnd = this.knownEmptyRunEnd(key, plan.windows);
    const earliestAvailableDate = emptyRunEnd
      ? this.dayAfter(emptyRunEnd, spanEnd)
      : null;
    const frontier = this.coveredThrough(key, plan.windows, outcome.answered);
    await this.recordPairCoverage(from, to, {
      earliestAvailableDate,
      firstGapDate: frontier ? this.dayAfter(frontier, spanEnd) : null,
      probedFrom: spanStart,
    });

    return {
      from,
      to,
      usedFrom,
      spanEnd,
      unresolvableDays: plan.unresolvableDays,
      sparseDays: plan.sparseDays,
      windowsPlanned: plan.windows.length,
      windowsFetched: outcome.fetched,
      windowsSkipped: skipped,
      windowsUnanswered: outcome.unanswered,
      // A window the provider did not answer is still to do, exactly like one
      // the bound never reached: the reader is told to press again rather than
      // being shown a total that silently dropped it. A skipped window is not
      // work left over -- asking again cannot fill it.
      windowsRemaining: live.length - outcome.attempted + outcome.unanswered,
      stored: outcome.stored,
      earliestDate: after.earliestDate,
      providerHasNothingBefore:
        earliestAvailableDate ?? coverage.earliestAvailableDate,
    };
  }

  /**
   * The refusal for a pair no configured provider carries: a coin side
   * without a price symbol names the Currencies page, which is the repair, as
   * the refresh does; any other pair names the pair.
   */
  private async uncarriedPair(
    from: string,
    to: string,
  ): Promise<BadRequestException> {
    const unmapped: Array<Pick<Currency, "code">> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.getRepository(Currency).find({
          select: { code: true },
          where: [
            { code: from, kind: "CRYPTO", quoteSymbol: IsNull() },
            { code: to, kind: "CRYPTO", quoteSymbol: IsNull() },
          ],
        }),
    );
    const coin = [from, to].find((code) =>
      unmapped.some((row) => row.code === code),
    );
    this.logger.warn(
      `Rate gap fill ${from}->${to}: no configured provider carries the pair`,
    );
    return new BadRequestException(
      coin !== undefined
        ? tr(
            "errors.currencies.noPriceSymbol",
            `${coin} has no price symbol; map one on the Currencies page`,
            { code: coin },
          )
        : tr(
            "errors.currencies.pairNotCarried",
            `No configured exchange rate provider carries ${from}/${to}`,
            { pair: `${from}/${to}` },
          ),
    );
  }

  /**
   * The day after `date`, never past the end of the span, so a pair the
   * provider has nothing at all for still names a date the market has reached.
   */
  private dayAfter(date: string, spanEnd: string): string {
    const next = addDaysYMD(date, 1);
    return next > spanEnd ? spanEnd : next;
  }

  /**
   * The end of the leading run of windows this deployment is done with, or
   * `null` when the oldest window is not one of them.
   *
   * Done with means one of two things, and they are deliberately treated
   * alike: the provider has answered the window with nothing, or this request
   * asked for it. A window that was asked for and came back sparse anyway is
   * the provider's best, and asking a third time would only spend the next
   * press's budget on it. A window neither skipped nor reached stops the run,
   * because everything past it is still owed.
   */
  private coveredThrough(
    key: string,
    planned: readonly RateGapWindow[],
    answered: ReadonlySet<string>,
  ): string | null {
    let covered: string | null = null;
    for (const window of planned) {
      const name = windowKey(window);
      if (!answered.has(name) && !this.emptyWindows.has(key, name)) break;
      covered = window.end;
    }
    return covered;
  }

  /**
   * The end of the leading run of windows the provider has answered with
   * nothing, or `null` when the oldest window is not one of them.
   *
   * Taken from the empty-window memory rather than from one request's own
   * results, so a press that skipped those windows establishes the same date
   * as the press that discovered them, and so a run of seven dead years names
   * the end of the seventh rather than of the first.
   */
  private knownEmptyRunEnd(
    key: string,
    windows: readonly RateGapWindow[],
  ): string | null {
    let lastEmptyEnd: string | null = null;
    for (const window of windows) {
      if (!this.emptyWindows.has(key, windowKey(window))) break;
      lastEmptyEnd = window.end;
    }
    return lastEmptyEnd;
  }

  /**
   * Ask the provider for each window in turn, stopping at the time budget.
   *
   * Every window handed here is one the provider has not already answered with
   * nothing: the caller drops those before the budget is applied, so a dead
   * stretch of history costs no call and no place in the cap.
   *
   * Sequential on purpose, for two recorded reasons. A burst of windows fired
   * from inside one HTTP request is what rate-limits everybody
   * (`net-worth/series-rate-fill.ts`). And only one concurrent call can hold
   * the circuit breaker's half-open probe, so parallel windows are refused and
   * read as empty history (`securities/market-index.service.ts`).
   */
  private async fetchWindows(
    from: string,
    to: string,
    windows: readonly RateGapWindow[],
  ): Promise<{
    attempted: number;
    fetched: number;
    unanswered: number;
    stored: number;
    /**
     * The windows the provider answered, empty or not. Named rather than
     * counted, because the resume pointer may only advance over the ones that
     * actually got an answer -- a window that timed out proved nothing and has
     * to stay in front of it.
     */
    answered: Set<string>;
    /**
     * The chain reported the pair uncarried: no provider that may be asked
     * carries it. A fact about the pair, not the window, so the loop stops at
     * the first, and the caller records nothing.
     */
    uncarried: boolean;
  }> {
    const key = directionlessPairKey(from, to);
    const deadline = Date.now() + GAP_FILL_BUDGET_MS;

    let attempted = 0;
    let fetched = 0;
    let unanswered = 0;
    let stored = 0;
    const answered = new Set<string>();

    for (const window of windows) {
      if (Date.now() >= deadline) break;
      attempted++;

      const result = await this.exchangeRateService.fillRateWindow(
        from,
        to,
        window.start,
        window.end,
      );
      if (result.carried === false) {
        return {
          attempted,
          fetched,
          unanswered,
          stored,
          answered,
          uncarried: true,
        };
      }
      fetched++;
      stored += result.stored;

      if (!result.answered) {
        unanswered++;
        continue;
      }
      answered.add(windowKey(window));
      if (result.stored === 0) {
        // The provider answered and had nothing here. Remember it, so neither
        // this pair's next press nor its own plan spends a call on the window
        // again; `knownEmptyFloor` reads the same memory to say where the
        // history starts.
        this.emptyWindows.remember(key, windowKey(window));
        this.logger.warn(
          `No rates available for ${from}/${to} over ${window.start} to ${window.end}`,
        );
      }
    }

    return {
      attempted,
      fetched,
      unanswered,
      stored,
      answered,
      uncarried: false,
    };
  }
}
