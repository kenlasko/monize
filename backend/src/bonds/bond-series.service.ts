import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { todayInTimezone } from "../common/date-utils";
import {
  describeFetchFailure,
  isTransportFailure,
} from "../common/http/fetch-failure.util";
import {
  bondProgramRefreshJob,
  bondSeriesAttemptJob,
  FetchProgress,
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import { tr } from "../i18n/translate";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { isProviderUnavailable } from "../provider-health/provider-unavailable.error";
import {
  BondAdapter,
  CatalogEntry,
  ManualSeriesValues,
  SeriesFetchError,
} from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { BenchmarkRefreshService } from "./benchmark-refresh.service";
import { BondCatalogService } from "./bond-catalog.service";
import { BondPriceService } from "./bond-price.service";
import { bondInstrumentId } from "./bond-instrument-id";
import { BondInstrumentSummary } from "./bond-valuation.service";
import { benchmarkReadsOf } from "./domain/benchmark-reads";
import { BondTermsError, parseBondTerms } from "./domain/bond-terms";
import { BondDataNotFoundError } from "./bond-errors";
import { HttpFetch, SeriesHttp } from "./series-http";

/**
 * Explicit fetches a user may make per window, on every entry point (REST, the
 * assistant, MCP): each may read the issuer's site. The counter is the shared
 * `auth_attempt_counters` row, so replicas agree, and an attempt counts whether
 * it succeeds, finds the series stored or fails.
 */
export const SERIES_FETCH_LIMIT = 10;
export const SERIES_FETCH_WINDOW_MS = 60_000;
export const SERIES_FETCH_SCOPE = "bond-series-fetch";

/** The catalog's answer to a series request: the instrument, and whether this call stored it. */
export interface BondSeriesResult extends BondInstrumentSummary {
  readonly created: boolean;
}

export interface SeriesRequestOptions {
  /** The network, injectable so a test never leaves the process. */
  readonly fetch?: HttpFetch;
  readonly adapters?: readonly BondAdapter[];
  /**
   * Only the programs named (`programKey`): the daily check fetches the
   * programs some security has switched auto-fetch on for. Absent, every
   * series is in scope (an explicit request). A series whose adapter cannot
   * name its program is out of scope when this is set.
   */
  readonly programs?: ReadonlySet<string>;
}

/**
 * What only an internal caller may pass to `fetchSeries`. No DTO, tool schema or
 * route reads it, so the REST route, the assistant and MCP always charge the
 * per-user allowance.
 */
export interface FetchSeriesOptions extends SeriesRequestOptions {
  /**
   * `"none"` skips the per-user explicit-fetch allowance: a backup restore is a
   * bounded one-off action that paces itself toward the issuer instead.
   */
  readonly limiter?: "user" | "none";
}

/** The key of a program in `SeriesRequestOptions.programs`. */
export function programKey(countryCode: string, programCode: string): string {
  return `${countryCode.toUpperCase()}|${programCode.toUpperCase()}`;
}

/** The codes of `adapter` that `options.programs` puts in scope. */
function inScope(
  adapter: BondAdapter,
  codes: readonly string[],
  options: SeriesRequestOptions,
): string[] {
  const { programs } = options;
  if (programs === undefined) return [...codes];
  const programOf = adapter.programOf;
  if (!programOf) return [];
  return codes.filter((code) => {
    const program = programOf.call(adapter, code);
    return (
      program !== null && programs.has(programKey(adapter.countryCode, program))
    );
  });
}

/** What a person polling a program's refresh reads; all empty when none ran. */
export interface RefreshProgress {
  readonly startedAt: string | null;
  readonly phase: "offer" | "series" | "done" | null;
  readonly done: number;
  readonly total: number;
  readonly seriesCode: string | null;
  readonly finishedAt: string | null;
}

/** What one daily check of the current offer did, in series. */
export interface CurrentOfferRun {
  readonly listed: number;
  readonly stored: number;
  readonly alreadyStored: number;
  readonly failed: number;
}

/** What one pass of the history backfill did, in series. */
export interface BackfillRun {
  /** Every code the adapters offered to try. */
  readonly candidates: number;
  /** Already in the catalog, so not asked for. */
  readonly alreadyStored: number;
  readonly stored: number;
  /** Refused as `SERIES_NOT_PUBLISHED`: a product not sold that month. */
  readonly notPublished: number;
  readonly failed: number;
  /** An adapter's pass stopped on `SOURCE_UNAVAILABLE`; the next run resumes. */
  readonly stoppedEarly: boolean;
  /**
   * Missing series this pass did not ask for: past its `limit`, or asked for
   * within `BACKFILL_ATTEMPT_INTERVAL_MS`; a later pass does.
   */
  readonly remaining: number;
}

export interface BackfillOptions extends SeriesRequestOptions {
  /** Waits between two requests; injectable so a test does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The adapters' day, YYYY-MM-DD; their own timezone's today when omitted. */
  readonly today?: string;
  /**
   * At most this many series are asked for, newest sale month first, so a pass
   * a person waits on stays short and fills the months they most likely hold
   * first; the rest is `remaining`. Absent, every missing series, oldest first.
   */
  readonly limit?: number;
  /**
   * Told how far the pass is, for a person watching a refresh: once per adapter
   * with the planned `total` (series the pass will try: at most `limit`, at
   * most the missing ones, before any attempt lease is claimed, so `done` may
   * stop short of it) and `done` as it stands, then after every attempt
   * (stored, refused or failed) with `done` one higher and that series' code.
   */
  readonly onProgress?: (progress: {
    done: number;
    total: number;
    seriesCode: string | null;
  }) => Promise<void>;
}

/**
 * The least time between two refreshes of one program's data, across every
 * replica: the lease `fetchProgramOffer` takes in `fetch_sync` and does not hand
 * back. Longer than one pass (about 30-40 s), so passes never overlap.
 */
export const PROGRAM_REFRESH_INTERVAL_MS = 90_000;

/**
 * How long a bounded pass leaves a series alone after asking for it once: the
 * attempt's lease in `fetch_sync`, so a series the source refused (not
 * published that month, or failed) is not asked for again by the next Refresh
 * on any replica, and the next pass moves on to other months.
 */
export const BACKFILL_ATTEMPT_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How many missing series of a program's history one price refresh asks for:
 * each is a 3 s gap and two requests, so about 30-40 s with a spinner, and a
 * few refreshes (or the daily check) fill the rest.
 */
export const PROGRAM_BACKFILL_CHUNK = 8;

/** The least time between two requests to the issuer's site by the backfill. */
export const BACKFILL_GAP_MS = 3000;

/**
 * The current-offer check (a page and a letter for each of a month's series)
 * and then the backfill of about 270 series: each is a gap of 3 s plus two
 * requests of a second or a few, so about half an hour; 90 minutes leaves room
 * for a slow source and is still far shorter than a day. A lease that ran out
 * mid-pass would let a second replica start one beside it, which only repeats
 * requests (every store is idempotent), so the figure is a cost control.
 */
const SERIES_LEASE_MS = 90 * 60 * 1000;

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gets a series that the catalog lacks from its market's official source, or
 * from an administrator's hand, into `bond_instruments` and `bond_terms_versions`
 * (INV-BOND-006). The service knows no country: the adapter owns the host, the
 * page and letter formats and the product templates, and names the provider the
 * request is gated under.
 *
 * Every check that can refuse runs before the transaction that writes
 * (`docs/specs/bond-series-fetch.md` section 2): the network read and the
 * adapter's parse happen first, and a refused read leaves no row. The write is
 * the catalog's own per-entry store, under an advisory lock keyed on the
 * instrument id, so two requests for one series insert once.
 */
@Injectable()
export class BondSeriesService {
  private readonly logger = new Logger(BondSeriesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: BondCatalogService,
    private readonly http: SeriesHttp,
    private readonly health: ProviderHealthService,
    private readonly fetchSync: FetchSyncService,
    private readonly prices: BondPriceService,
    private readonly benchmarks: BenchmarkRefreshService,
    private readonly attempts: AuthAttemptCounterService,
  ) {}

  /**
   * The series from the official source: the stored instrument when its first
   * terms version is already stored (nothing is fetched), else the adapter's
   * fetch, stored. Needs an ambient identity, like any database access.
   */
  async fetchSeries(
    userId: string,
    countryCode: string,
    seriesCode: string,
    options: FetchSeriesOptions = {},
  ): Promise<BondSeriesResult> {
    if (options.limiter !== "none") await this.chargeFetchAttempt(userId);
    const result = await this.fetchAndStore(countryCode, seriesCode, options);
    // Detached: the network benchmark refresh and the every-user price recompute
    // must not hold the person's REST/AI/MCP answer. The row is committed, and
    // a recompute that fails is logged and repaired by the daily job.
    this.dispatchAfterStored([result]);
    return result;
  }

  /**
   * One explicit fetch attempt against the user's per-minute allowance, before
   * anything is read or requested: the attempt is counted first, so a failed
   * fetch is charged like a successful one and the refused one sends no request.
   * The same allowance for the REST route, the assistant and MCP.
   */
  private async chargeFetchAttempt(userId: string): Promise<void> {
    const { count } = await this.attempts.increment(
      SERIES_FETCH_SCOPE,
      userId,
      SERIES_FETCH_WINDOW_MS,
      "fixed",
    );
    if (count > SERIES_FETCH_LIMIT) {
      throw new HttpException(
        {
          message: tr(
            "errors.bonds.SERIES_FETCH_RATE_LIMITED",
            `At most ${SERIES_FETCH_LIMIT} bond series can be fetched per minute; wait a minute and try again.`,
            { limit: String(SERIES_FETCH_LIMIT) },
          ),
          errorCode: "SERIES_FETCH_RATE_LIMITED",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * `afterStored` after the commit, not awaited. It runs outside the request's
   * scoped manager (a manager outlives neither the response nor its
   * transaction) and under identities of its own: the benchmark refresh and the
   * price recompute each seed `withSystemContext` / `withUserContext`. Its own
   * failure is a log line, never an unhandled rejection or the caller's error.
   */
  private dispatchAfterStored(
    results: ReadonlyArray<Pick<BondSeriesResult, "id" | "created">>,
  ): void {
    runOutsideActiveScopedManager(() => {
      Promise.resolve()
        .then(() => this.afterStored(results))
        .catch((error: unknown) =>
          this.logger.warn(
            `Bond post-store refresh and recompute failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    });
  }

  /**
   * Once the store has committed (INV-CACHE-001): a benchmark the stored series
   * read that was never fetched is refreshed first (spec
   * bond-program-securities.md 2.6), then the engine prices of the securities of
   * the program of every series this call stored are recomputed, so a row
   * recorded before its series existed resolves to a lot, with its observations.
   */
  private async afterStored(
    results: ReadonlyArray<Pick<BondSeriesResult, "id" | "created">>,
  ): Promise<void> {
    const ids = results.filter((r) => r.created).map((r) => r.id);
    await this.benchmarks.refreshNeverFetched(ids);
    await this.prices.recomputeLinkedSecuritiesOfSeries(ids);
  }

  /** `fetchSeries` without the recompute: a pass that stores many series recomputes once. */
  private async fetchAndStore(
    countryCode: string,
    seriesCode: string,
    options: SeriesRequestOptions = {},
  ): Promise<BondSeriesResult> {
    const country = countryCode.toUpperCase();
    const series = seriesCode.trim().toUpperCase();
    const adapter = this.adapterFor(country, series, options.adapters);
    const fetchSeries = adapter.fetchSeries;
    const providerId = adapter.seriesProviderId;
    if (!fetchSeries || !providerId) throw this.unsupported(country, series);

    const stored = await withScopedDb(this.dataSource, (m) =>
      this.catalog.findStoredSeries(m, adapter.countryCode, series),
    );
    if (stored) return { ...stored, created: false };

    let entry: CatalogEntry;
    try {
      const fetched = await fetchSeries.call(
        adapter,
        series,
        this.http.gated(providerId, options.fetch),
      );
      entry = fetched.entry;
    } catch (error) {
      throw this.named(error, country, series);
    }
    return this.store(entry, country, series, adapter);
  }

  /**
   * An administrator's values on the adapter's template, stored like a fetched
   * series with `source.provider` `manual`. The caller has checked the role
   * (`isAdministrator`); the bounds and the strict parser are the adapter's.
   */
  async enterManually(
    countryCode: string,
    seriesCode: string,
    values: ManualSeriesValues,
    options: Pick<SeriesRequestOptions, "adapters"> = {},
  ): Promise<BondSeriesResult> {
    const country = countryCode.toUpperCase();
    const series = seriesCode.trim().toUpperCase();
    const adapter = this.adapterFor(country, series, options.adapters);
    if (!adapter.manualSeries) throw this.unsupported(country, series);
    let entry: CatalogEntry;
    try {
      entry = adapter.manualSeries(series, values);
    } catch (error) {
      throw this.named(error, country, series);
    }
    const result = await this.store(entry, country, series, adapter);
    await this.afterStored([result]);
    return result;
  }

  /**
   * Runs an administrator's values through the adapter's bounds and strict
   * parser without storing anything, so a person is asked to confirm only a
   * series that would be accepted. Throws the same refusals as `enterManually`.
   */
  checkManual(
    countryCode: string,
    seriesCode: string,
    values: ManualSeriesValues,
    options: Pick<SeriesRequestOptions, "adapters"> = {},
  ): void {
    const country = countryCode.toUpperCase();
    const series = seriesCode.trim().toUpperCase();
    const adapter = this.adapterFor(country, series, options.adapters);
    if (!adapter.manualSeries) throw this.unsupported(country, series);
    try {
      adapter.manualSeries(series, values);
    } catch (error) {
      throw this.named(error, country, series);
    }
  }

  /**
   * Whether the user holds the administrator role, read from their row (the
   * MCP and the AI tools have no guard in front of them). Needs an ambient
   * identity for the user.
   */
  async isAdministrator(userId: string): Promise<boolean> {
    const rows: Array<{ role: string }> = await withScopedDb(
      this.dataSource,
      (m) => m.query(`SELECT role FROM users WHERE id = $1`, [userId]),
    );
    return rows[0]?.role === "admin";
  }

  /**
   * Daily, after the price recompute (06:45): a new month's series go on sale
   * on the first, and storing them without anyone asking means the picker finds
   * them; then the one-off history backfill (`backfillHistory`) fills what the
   * offer pass does not reach. Cross-user work with no request behind it, so it seeds its own system
   * context around the whole lease call; the lease is a cost control, because
   * the store is idempotent however many replicas run
   * (`docs/backend/cron-and-background-work.md`).
   */
  // The timezone is spelled as a literal: cron-doc.spec.ts reads it from the decorator.
  @Cron("15 7 * * *", { timeZone: "Europe/Warsaw" })
  async scheduledCurrentOffer(): Promise<void> {
    try {
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.BondSeries,
          SERIES_LEASE_MS,
          async () => {
            // Only the programs a security has switched auto-fetch on for
            // (docs/specs/bond-program-securities.md 2.5); none, nothing to do.
            const programs = await this.autoFetchPrograms();
            if (programs.size === 0) {
              this.logger.log(
                "Bond series check skipped: no security has auto-fetch switched on",
              );
              return;
            }
            // The backfill follows even when the offer failed, so the failure
            // still reaches the lease record, after the history had its turn.
            let offerFailure: unknown = null;
            try {
              await this.fetchCurrentOffer({ programs });
            } catch (error) {
              offerFailure = error;
            }
            await this.backfillHistory({ programs });
            if (offerFailure !== null) throw offerFailure;
          },
        ),
      );
    } catch (error) {
      // `withLease` has already recorded the failure in fetch_sync, and each
      // series logged its own cause; a cron must not die on it.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scheduled bond series check failed: ${message}`);
    }
  }

  /**
   * The programs at least one security has switched auto-fetch on for, as
   * `programKey`s. One query in the cron's system context that reads program
   * columns only: never anything of the user's but the flag that selects the
   * program. Needs an ambient identity (`withSystemContext`).
   */
  async autoFetchPrograms(): Promise<Set<string>> {
    const rows: Array<{
      issuer_country_code: string;
      program_code: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT DISTINCT p.issuer_country_code, p.program_code
           FROM bond_programs p
          WHERE EXISTS (SELECT 1 FROM securities s
                         WHERE s.bond_program_id = p.id AND s.bond_auto_fetch)`,
      ),
    );
    return new Set(
      rows.map((r) => programKey(r.issuer_country_code, r.program_code)),
    );
  }

  /**
   * Every series each adapter lists as on sale and the catalog lacks. A series
   * already stored is not fetched; one failing is logged and does not stop the
   * next. Throws at the end when everything attempted failed, so the lease
   * wrapper records a failure rather than a success. Needs an ambient identity
   * (`withSystemContext`).
   */
  async fetchCurrentOffer(
    options: SeriesRequestOptions = {},
  ): Promise<CurrentOfferRun> {
    const run = await this.runCurrentOffer(options);
    if (run.failed > 0 && run.stored + run.alreadyStored === 0) {
      throw new Error(
        `Every bond series check failed (${run.failed}); see the log for each cause`,
      );
    }
    return run;
  }

  /**
   * The user-initiated "fetch the current offer now" of one country: every
   * series of its current offer that is not stored is fetched and stored
   * (today through `fetchProgramOffer`, one program). A country with no fetch is refused
   * (`SERIES_FETCH_UNSUPPORTED`); a source that cannot be read is counted in
   * `failed` rather than thrown, so the caller learns what was and was not
   * stored. Needs an ambient identity.
   */
  async fetchOfferOf(
    countryCode: string,
    options: SeriesRequestOptions = {},
  ): Promise<CurrentOfferRun> {
    const country = countryCode.toUpperCase();
    const adapters = (options.adapters ?? INSTALLED_BOND_ADAPTERS).filter(
      (a) =>
        a.countryCode === country &&
        a.currentSeries &&
        a.fetchSeries &&
        a.seriesProviderId,
    );
    if (adapters.length === 0) throw this.unsupported(country, "");
    return this.runCurrentOffer({ ...options, adapters });
  }

  /**
   * "Refresh" of a security linked to a program (`recomputeLinkedPrices`): the
   * current offer of one program only, fetched and stored like `fetchOfferOf`
   * (series already stored are not fetched; the benchmark refresh and the price
   * recompute follow synchronously). A country with no fetch is refused
   * (`SERIES_FETCH_UNSUPPORTED`); a source that cannot be read is counted in
   * `failed`. A person's action (INV-BOND-008). Needs an ambient identity.
   *
   * Progress is written to the program's `fetch_sync` row while it runs
   * (`FetchSyncService.reportProgress`: offer, then series with the code of
   * each attempt, then done, also when the pass throws) for
   * `readRefreshProgress`; a failed write is logged and never fails the refresh.
   *
   * Then up to `PROGRAM_BACKFILL_CHUNK` missing series of the program's history
   * are fetched, newest first (`history`), so a few refreshes fill it without
   * work in the background; the daily check fills it too while auto-fetch is on.
   *
   * The price refresh has no throttle of its own, so the requests are bounded
   * here, in a row every replica sees: a pass takes the program's lease in
   * `fetch_sync` for `PROGRAM_REFRESH_INTERVAL_MS` and never hands it back, so
   * one program is refreshed at most once per interval however often, and on
   * however many replicas, a person presses Refresh; a refresh inside the
   * interval answers an empty run. The history asks only for what is missing,
   * at the backfill's own pace.
   */
  async fetchProgramOffer(
    countryCode: string,
    programCode: string,
    options: BackfillOptions = {},
  ): Promise<CurrentOfferRun & { readonly history: BackfillRun | null }> {
    const country = countryCode.toUpperCase();
    const key = programKey(country, programCode);
    const idle = { listed: 0, stored: 0, alreadyStored: 0, failed: 0 };
    const job = bondProgramRefreshJob(key);
    const lease = await this.fetchSync.claim(job, PROGRAM_REFRESH_INTERVAL_MS);
    if (lease === null) return { ...idle, history: null };
    const programs = new Set([key]);
    // What a person polling the refresh reads (`fetch_sync.progress`). A write
    // that fails is a log line: the refresh itself must go on.
    const startedAt = new Date().toISOString();
    let last: FetchProgress = {
      startedAt,
      phase: "offer",
      done: 0,
      total: 0,
      seriesCode: null,
      finishedAt: null,
    };
    const report = async (next: FetchProgress): Promise<void> => {
      last = next;
      try {
        await this.fetchSync.reportProgress(job, lease, next);
      } catch (error) {
        this.logger.warn(
          `Progress of ${job} could not be recorded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    await report(last);
    try {
      const offer = await this.fetchOfferOf(country, { ...options, programs });
      await report({ ...last, phase: "series" });
      // Then a bounded piece of the program's history. Paced by the backfill's
      // own gap and asking only for what is missing, so once the history is
      // complete a refresh costs no request here at all.
      const history = await this.backfillHistory({
        ...options,
        programs,
        limit: options.limit ?? PROGRAM_BACKFILL_CHUNK,
        onProgress: async (p) => {
          await report({ ...last, phase: "series", ...p });
          await options.onProgress?.(p);
        },
      });
      // The lease is never handed back (no `release`, no `markSuccess`, which
      // releases too): its expiry is the interval.
      return { ...offer, history };
    } finally {
      await report({
        ...last,
        phase: "done",
        finishedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * The progress of the program's refresh, from its `fetch_sync` row
   * (`fetchProgramOffer` writes it). Global reference data, read under the
   * caller's identity. An unknown program is `PROGRAM_NOT_FOUND`; a program
   * never refreshed answers the empty shape.
   */
  async readRefreshProgress(programId: string): Promise<RefreshProgress> {
    const rows: Array<{ issuer_country_code: string; program_code: string }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT issuer_country_code, program_code FROM bond_programs WHERE id = $1::uuid`,
          [programId],
        ),
      );
    if (rows.length === 0) {
      throw new BondDataNotFoundError(
        "PROGRAM_NOT_FOUND",
        { id: programId },
        `No bond program is stored with id ${programId}`,
      );
    }
    const progress = await this.fetchSync.readProgress(
      bondProgramRefreshJob(
        programKey(rows[0].issuer_country_code, rows[0].program_code),
      ),
    );
    if (!progress) {
      return {
        startedAt: null,
        phase: null,
        done: 0,
        total: 0,
        seriesCode: null,
        finishedAt: null,
      };
    }
    return {
      startedAt: progress.startedAt ?? null,
      phase: progress.phase ?? null,
      done: progress.done ?? 0,
      total: progress.total ?? 0,
      seriesCode: progress.seriesCode ?? null,
      finishedAt: progress.finishedAt ?? null,
    };
  }

  private async runCurrentOffer(
    options: SeriesRequestOptions,
  ): Promise<CurrentOfferRun> {
    let listed = 0;
    let stored = 0;
    let alreadyStored = 0;
    let failed = 0;
    const storedNow: BondSeriesResult[] = [];
    for (const adapter of options.adapters ?? INSTALLED_BOND_ADAPTERS) {
      const providerId = adapter.seriesProviderId;
      if (!adapter.currentSeries || !adapter.fetchSeries || !providerId)
        continue;
      let codes: string[];
      try {
        codes = await adapter.currentSeries(
          this.http.gated(providerId, options.fetch),
        );
      } catch (error) {
        failed += 1;
        this.logRefusal(
          `current offer of ${adapter.countryCode}`,
          providerId,
          error,
        );
        continue;
      }
      const inScopeCodes = inScope(adapter, codes, options);
      listed += inScopeCodes.length;
      for (const code of inScopeCodes) {
        try {
          const result = await this.fetchAndStore(adapter.countryCode, code, {
            ...options,
            adapters: [adapter],
          });
          storedNow.push(result);
          if (result.created) stored += 1;
          else alreadyStored += 1;
        } catch (error) {
          failed += 1;
          this.logRefusal(
            `${adapter.countryCode} series ${code}`,
            providerId,
            error,
          );
        }
      }
    }
    await this.afterStored(storedNow);
    this.logger.log(
      `Bond series check: ${listed} listed, ${stored} stored, ${alreadyStored} already stored, ${failed} failed`,
    );
    return { listed, stored, alreadyStored, failed };
  }

  /**
   * The history backfill (`docs/specs/bond-offer-and-history.md` section 4):
   * every series code each adapter offers (`backfillCodes`) that the catalog
   * lacks, asked for one at a time with `BACKFILL_GAP_MS` before each request.
   * Only series that are not stored are asked for, so a rerun is idempotent and
   * a run that stopped resumes where it stopped. `SOURCE_UNAVAILABLE` ends that
   * adapter's pass (the source is down; the next daily run resumes); a series
   * the source does not publish, or any other refusal, is logged and the pass
   * goes on (`SOURCE_DOCUMENT_MISSING`, a series' own document answering a
   * permanent 4xx, is such a refusal and counts as failed). Needs an ambient
   * identity (`withSystemContext`).
   */
  async backfillHistory(options: BackfillOptions = {}): Promise<BackfillRun> {
    const sleep = options.sleep ?? defaultSleep;
    let candidates = 0;
    let alreadyStored = 0;
    let stored = 0;
    let notPublished = 0;
    let failed = 0;
    let stoppedEarly = false;
    let remaining = 0;
    let attempted = 0;
    let plannedTotal = 0;
    let progressDone = 0;
    const storedNow: BondSeriesResult[] = [];
    for (const adapter of options.adapters ?? INSTALLED_BOND_ADAPTERS) {
      const providerId = adapter.seriesProviderId;
      if (!adapter.backfillCodes || !adapter.fetchSeries || !providerId)
        continue;
      const today =
        options.today ??
        todayInTimezone(adapter.timezone) ??
        (todayInTimezone("UTC") as string);
      const codes = inScope(adapter, adapter.backfillCodes(today), options);
      const held = await withScopedDb(this.dataSource, (m) =>
        this.catalog.storedSeriesCodes(m, adapter.countryCode, codes),
      );
      const allMissing = codes.filter((code) => !held.has(code.toUpperCase()));
      candidates += codes.length;
      alreadyStored += codes.length - allMissing.length;
      // `backfillCodes` lists oldest first; a bounded pass takes the newest.
      const ordered =
        options.limit === undefined ? allMissing : [...allMissing].reverse();
      plannedTotal += allMissing.length;
      if (options.limit !== undefined) {
        plannedTotal = Math.min(plannedTotal, options.limit);
      }
      await options.onProgress?.({
        done: progressDone,
        total: plannedTotal,
        seriesCode: null,
      });
      for (const code of ordered) {
        if (options.limit !== undefined) {
          if (attempted >= options.limit) {
            remaining += 1;
            continue;
          }
          // One attempt per series per BACKFILL_ATTEMPT_INTERVAL_MS, in a row
          // every replica sees; a lost claim is a series asked for recently.
          const claimed = await this.fetchSync.claim(
            bondSeriesAttemptJob(adapter.countryCode, code),
            BACKFILL_ATTEMPT_INTERVAL_MS,
          );
          if (claimed === null) {
            remaining += 1;
            continue;
          }
          attempted += 1;
        }
        // Before every request, the first included: the current-offer pass has
        // just spoken to the same host.
        await sleep(BACKFILL_GAP_MS);
        try {
          const result = await this.fetchAndStore(adapter.countryCode, code, {
            ...options,
            adapters: [adapter],
          });
          storedNow.push(result);
          if (result.created) stored += 1;
          else alreadyStored += 1;
        } catch (error) {
          this.logRefusal(
            `${adapter.countryCode} series ${code} (backfill)`,
            providerId,
            error,
          );
          const refusal = error instanceof SeriesFetchError ? error.code : null;
          if (refusal === "SOURCE_UNAVAILABLE") {
            failed += 1;
            stoppedEarly = true;
            break;
          }
          if (refusal === "SERIES_NOT_PUBLISHED") notPublished += 1;
          else failed += 1;
        } finally {
          progressDone += 1;
          await options.onProgress?.({
            done: progressDone,
            total: plannedTotal,
            seriesCode: code,
          });
        }
      }
    }
    await this.afterStored(storedNow);
    this.logger.log(
      `Bond series backfill: ${candidates} candidates, ${alreadyStored} already stored, ${stored} stored, ` +
        `${notPublished} not published, ${failed} failed, ${remaining} left for a later pass` +
        `${stoppedEarly ? ", stopped on an unavailable source" : ""}`,
    );
    return {
      candidates,
      alreadyStored,
      stored,
      notPublished,
      failed,
      stoppedEarly,
      remaining,
    };
  }

  /**
   * One transaction: the advisory lock on the instrument, then the catalog's
   * store, which re-reads inside the lock. The same content is "already
   * stored"; different content is refused and the transaction rolls back, so a
   * refused request leaves nothing (INV-BOND-001).
   */
  private async store(
    entry: CatalogEntry,
    country: string,
    series: string,
    adapter: BondAdapter,
  ): Promise<BondSeriesResult> {
    let instrumentId: string;
    let benchmarkCodes: ReadonlySet<string>;
    try {
      const terms = parseBondTerms(entry.terms);
      const { instrument } = terms;
      benchmarkCodes = new Set(
        benchmarkReadsOf(terms).map((read) => read.benchmarkId),
      );
      instrumentId = bondInstrumentId(
        instrument.issuerCountryCode,
        instrument.issuerCode,
        instrument.seriesCode,
      );
    } catch (error) {
      if (error instanceof BondTermsError) {
        throw this.named(
          new SeriesFetchError(
            "SOURCE_FORMAT_CHANGED",
            { field: "terms" },
            { cause: error },
          ),
          country,
          series,
        );
      }
      throw error;
    }

    return withScopedDb(this.dataSource, async (m) => {
      await acquireAdvisoryLock(m, LockScope.BondSeriesFetch, instrumentId);
      const outcome = await this.catalog.storeEntry(m, entry);
      switch (outcome.kind) {
        case "invalid":
          throw this.named(
            new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "terms" }),
            country,
            series,
          );
        case "conflict":
        case "instrument-mismatch":
          this.logger.error(
            `Series ${outcome.named} is stored with different terms than the ones just read ` +
              `(${outcome.kind}); stored terms are immutable (INV-BOND-001), so nothing was written.`,
          );
          throw this.named(
            new SeriesFetchError("SERIES_TERMS_CONFLICT"),
            country,
            series,
          );
        case "inserted":
        case "unchanged": {
          const summary = await this.catalog.findSummary(
            m,
            outcome.instrumentId,
          );
          if (!summary) {
            // Unreachable inside the transaction that has just stored it.
            throw new Error(`Stored series ${outcome.named} cannot be read`);
          }
          if (outcome.kind === "inserted") {
            this.logger.log(`Stored terms version 1 of ${outcome.named}`);
          }
          // The series rows of the benchmarks it reads, in the same transaction,
          // so a valuation names the publisher of an observation it lacks even
          // before the first fetch lands; the fetch itself follows the commit.
          if (benchmarkCodes.size > 0) {
            await this.catalog.seedBenchmarkSeries([adapter], benchmarkCodes);
          }
          return { ...summary, created: outcome.kind === "inserted" };
        }
      }
    });
  }

  private adapterFor(
    country: string,
    series: string,
    adapters: readonly BondAdapter[] = INSTALLED_BOND_ADAPTERS,
  ): BondAdapter {
    const adapter = adapters.find((a) => a.countryCode === country);
    if (!adapter) throw this.unsupported(country, series);
    return adapter;
  }

  private unsupported(country: string, series: string): SeriesFetchError {
    return new SeriesFetchError("SERIES_FETCH_UNSUPPORTED", {
      country,
      series,
    });
  }

  /**
   * An adapter's refusal, naming the request on its params (the message names
   * the series and the country, which the adapter does not know). Anything that
   * is not a series refusal passes through unchanged.
   */
  private named(error: unknown, country: string, series: string): unknown {
    if (!(error instanceof SeriesFetchError)) return error;
    return new SeriesFetchError(
      error.code,
      { country, series, ...error.params },
      { cause: error.cause },
    );
  }

  /** A refused series in the log: its code and params, and the transport cause when there is one. */
  private logRefusal(what: string, providerId: string, error: unknown): void {
    const cause = error instanceof SeriesFetchError ? error.cause : error;
    if (
      cause !== undefined &&
      (isProviderUnavailable(cause) || isTransportFailure(cause))
    ) {
      // Rate-limited and counted by the breaker; a refused call prints nothing.
      this.health.logFailure(this.logger, providerId, `bond ${what}`, cause);
      return;
    }
    const reason =
      error instanceof SeriesFetchError
        ? error.message
        : describeFetchFailure(error);
    this.logger.warn(`Bond series fetch for ${what} refused: ${reason}`);
  }
}
