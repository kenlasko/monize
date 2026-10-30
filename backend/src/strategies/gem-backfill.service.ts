import { Injectable, Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { Security } from "../securities/entities/security.entity";
import { SecurityPriceService } from "../securities/security-price.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { GemPriceService } from "./gem-price.service";
import { GemCadence } from "./entities/gem-strategy.entity";
import {
  BOUNDARY_LAG_DAYS,
  PricePoint,
  addMonthsUtc,
  cadenceMonths,
  closeAt,
  parseYmd,
  recentPeriods,
} from "./gem-momentum.util";
import { GEM_HISTORY_PERIODS } from "./gem-signal.service";

/**
 * Do not ask the quote provider for the same security again within this window.
 * A symbol the provider has no data for would otherwise be re-fetched on every
 * configuration save.
 */
const BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Months of history the report wants: the momentum window plus the span the
 * signal history table covers. That span is measured in *periods*, so a
 * quarterly strategy needs three times the months a monthly one does -- reading
 * the periods as months would leave its oldest evaluations permanently
 * unpriced, and re-attempted on every read.
 */
function requiredMonths(lookbackMonths: number, cadence: GemCadence): number {
  return lookbackMonths + GEM_HISTORY_PERIODS * cadenceMonths(cadence);
}

/** Provider range that covers `months`, from the ranges the providers accept. */
function rangeFor(months: number): string {
  if (months <= 12) return "1y";
  if (months <= 60) return "5y";
  if (months <= 120) return "10y";
  return "max";
}

/**
 * ISO date `months` before today.
 *
 * Through `addMonthsUtc`, which clamps to the target month's last day. Raw
 * `setUTCMonth` overflows instead: from the 31st it lands on the 1st or 2nd of
 * the *following* month, which can push the coverage floor past a close that
 * would have satisfied it and leave a provider fetch re-attempted forever.
 */
function monthsAgo(months: number): string {
  return addMonthsUtc(parseYmd(todayYMD()), -months).toISOString().slice(0, 10);
}

/**
 * Every date the strategy has to be able to price, oldest first.
 *
 * Two per evaluated period -- the momentum window's start and the evaluation
 * itself -- plus today, because a signal is only current if the newest boundary
 * can be priced. These are exactly the boundaries `evaluate` reads, so a
 * security that satisfies all of them can answer the whole report.
 */
function requiredBoundaries(
  asOf: string,
  lookbackMonths: number,
  cadence: GemCadence,
): string[] {
  const boundaries = new Set<string>([asOf]);
  for (const period of recentPeriods(asOf, cadence, GEM_HISTORY_PERIODS)) {
    boundaries.add(period.evaluatedOn);
    boundaries.add(
      addMonthsUtc(parseYmd(period.evaluatedOn), -lookbackMonths)
        .toISOString()
        .slice(0, 10),
    );
  }
  return [...boundaries].sort();
}

/**
 * Whether a series can price every boundary the strategy needs.
 *
 * The earliest stored date was the only thing checked before, which answers a
 * different question: a security with one observation from 2015 and nothing
 * since reaches back far enough and can price none of the periods the report
 * actually shows. So did a series with the middle missing, or one whose feed
 * stopped last spring -- all three skipped the provider while the strategy sat
 * without a signal, and the save that promised to ensure the history reported
 * success.
 *
 * `closeAt` is the same freshness rule the evaluator applies, so this asks
 * precisely "would the evaluation find a price here", not an approximation of
 * it.
 */
function coversBoundaries(
  series: PricePoint[] | undefined,
  boundaries: string[],
): boolean {
  if (!series?.length) return false;
  return boundaries.every((boundary) => closeAt(series, boundary) !== null);
}

/**
 * Fetches the price history a freshly configured GEM strategy is missing.
 *
 * Assigning an instrument to a role is the moment the strategy becomes able to
 * produce a signal -- but a security the user has just created carries no
 * prices yet, and momentum cannot be computed from nothing. Rather than leave
 * the first signal to appear whenever the background backfill happens to land,
 * the configuration save pulls the history in and then evaluates.
 */
@Injectable()
export class GemBackfillService {
  private readonly logger = new Logger(GemBackfillService.name);

  constructor(
    private dataSource: DataSource,
    private priceService: GemPriceService,
    private securityPriceService: SecurityPriceService,
    private exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * Ensure every given security has prices reaching back far enough for the
   * strategy, fetching what is missing. Returns the securities it fetched for.
   *
   * A provider failure is logged, not thrown: the report renders its
   * incomplete-history warning, which is a better outcome than a save that
   * appears to have failed.
   */
  async ensureHistory(
    userId: string,
    securityIds: string[],
    lookbackMonths: number,
    cadence: GemCadence,
  ): Promise<string[]> {
    const wanted = [...new Set(securityIds)];
    if (wanted.length === 0) return [];

    const months = requiredMonths(lookbackMonths, cadence);
    const needFrom = monthsAgo(months);
    const asOf = todayYMD();
    const boundaries = requiredBoundaries(asOf, lookbackMonths, cadence);
    // Load from a fortnight before the oldest boundary: a boundary may be
    // priced by a close struck up to `BOUNDARY_LAG_DAYS` earlier, and cutting
    // the window at the boundary itself would hide exactly those.
    const seriesFrom = new Date(`${needFrom}T00:00:00Z`);
    seriesFrom.setUTCDate(seriesFrom.getUTCDate() - BOUNDARY_LAG_DAYS);
    const series = await this.priceService.loadSeries(
      wanted,
      seriesFrom.toISOString().slice(0, 10),
      "day",
    );
    const short = wanted.filter(
      (id) => !coversBoundaries(series.get(id), boundaries),
    );
    // Prices alone do not make a role priced: a foreign close with no rate is
    // dropped from the report-currency series, so the rates are ensured too.
    await this.ensureRateHistory(
      userId,
      wanted.filter((id) => !short.includes(id)),
      series,
      boundaries,
      seriesFrom.toISOString().slice(0, 10),
    );
    if (short.length === 0) return [];

    const securities = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Security)
        .find({ where: { id: In(short), userId } }),
    );
    const now = Date.now();
    const due = securities.filter((security) => {
      const last = security.historicalBackfillAttemptedAt;
      if (!last) return true;
      const lastMs =
        last instanceof Date ? last.getTime() : Date.parse(String(last));
      return !Number.isFinite(lastMs) || now - lastMs > BACKFILL_COOLDOWN_MS;
    });
    if (due.length === 0) return [];

    const range = rangeFor(months);
    await Promise.all(
      due.map((security) =>
        this.securityPriceService
          .backfillSecurityRange(security, range)
          .catch((error: unknown) => {
            this.logger.warn(
              `GEM history backfill failed for ${security.symbol}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return 0;
          }),
      ),
    );

    // Stamp every attempt, successful or not: the cooldown exists to spare the
    // provider, not to record whether the data improved.
    await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Security)
        .update(
          { id: In(due.map((security) => security.id)), userId },
          { historicalBackfillAttemptedAt: new Date() },
        ),
    );

    return due.map((security) => security.id);
  }

  /**
   * Fetch the exchange-rate history behind boundaries that a price covers in
   * its own currency but the report-currency series cannot. Best effort, and
   * gated by the rate service's own provider chain; the price backfill is not
   * asked, since the prices are there.
   */
  private async ensureRateHistory(
    userId: string,
    pricedIds: string[],
    rawSeries: Map<string, PricePoint[]>,
    boundaries: string[],
    seriesFrom: string,
  ): Promise<void> {
    if (pricedIds.length === 0) return;
    const securities = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Security)
        .find({ where: { id: In(pricedIds), userId } }),
    );
    const reportCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    const foreign = securities.filter(
      (security) =>
        !!security.currencyCode && security.currencyCode !== reportCurrency,
    );
    if (foreign.length === 0) return;

    const converted = await this.priceService.loadSeries(
      foreign.map((security) => security.id),
      seriesFrom,
      "day",
      undefined,
      userId,
    );
    for (const security of foreign) {
      const raw = rawSeries.get(security.id);
      const priced = converted.get(security.id);
      const pair = { from: security.currencyCode, to: reportCurrency };
      for (const boundary of boundaries) {
        if (closeAt(raw ?? [], boundary) === null) continue;
        if (priced && closeAt(priced, boundary) !== null) continue;
        try {
          await this.exchangeRateService.ensureRatesForDate([pair], boundary);
        } catch (error) {
          this.logger.warn(
            `GEM rate history fetch ${pair.from}->${pair.to} for ${boundary} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
}
