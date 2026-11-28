import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import { todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { PortfolioService } from "../securities/portfolio.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  NotificationSeverity,
  NotificationType,
} from "./entities/notification.entity";
import { CreateNotificationInput } from "./notification.service";
import { FlowSubtotal, foldExternalFlow } from "./portfolio-flow.util";
import {
  BaselinePosition,
  LatePrice,
  PriceObservation,
  latePriceAdjustment,
  parseBaselinePositions,
  snapshotPositions,
} from "./portfolio-price-freshness.util";
import {
  NumberT,
  defaultNumberT,
  numberFormatterFor,
} from "../common/number-locale.util";
import {
  FiredMovement,
  MovementInputs,
  decideMovement,
} from "./portfolio-movement.util";

/** A user's opted-in threshold and stored baseline, read for one evaluation. */
interface PortfolioStateRow {
  move_alert_percent: string | null;
  baseline_value: string | null;
  baseline_currency: string | null;
  baseline_captured_on: string | null;
  baseline_positions: unknown;
}

/**
 * Daily notification of the market-driven change in a user's investment-account
 * value, net of external cash flows -- so a deposit does not fire a false gain
 * and a dividend is return, not a loss
 * (`docs/specs/portfolio-movement-notifications.md`).
 *
 * The measure is `MV(today) - MV(baseline) - externalFlow`: today's portfolio
 * value from `getPortfolioSummary` (holdings + cash, in the reporting currency,
 * with its own completeness flag), the last COMPLETE value the producer stored,
 * and the day's cash that crossed the investment-account boundary from outside.
 * A subtotal is never fired and never becomes a baseline (INV-PORTMOVE-001).
 *
 * Two things make the figure evidence rather than arithmetic. The flow is
 * converted at the date each amount crossed the boundary, never at the run's
 * date (INV-PORTMOVE-007). A position carried at an old close would book its
 * whole catch-up as a market move on the day its new close arrives, so the
 * baseline stores the close and date that valued each held security, and a run
 * in which a close that was already old at the baseline has been replaced
 * restates the baseline at the new close: the catch-up is removed from the
 * movement and named in the alert, and the baseline still advances, so a
 * holding priced by hand never silences the alert (INV-PORTMOVE-008).
 *
 * The withhold policy and the arithmetic live in `decideMovement`
 * (`portfolio-movement.util.ts`), the flow conversion in `foldExternalFlow`
 * (`portfolio-flow.util.ts`) and the late-price rule in `latePriceAdjustment`
 * (`portfolio-price-freshness.util.ts`); all three are pure and unit-tested.
 * This service is the cron plumbing, the flow query and the baseline
 * read-modify-write.
 */
@Injectable()
export class PortfolioMovementAlertService {
  private readonly logger = new Logger(PortfolioMovementAlertService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly portfolio: PortfolioService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Daily on weekdays, after the security-price (5 PM ET), market-index
   * (5:10 PM ET) and GEM (5:30 PM ET) jobs, so today's value is priced.
   */
  @Cron("40 17 * * 1-5", { timeZone: "America/New_York" })
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const userIds = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) =>
          returnedRows<{ user_id: string }>(
            await manager.query(
              `SELECT user_id FROM notification_portfolio_state
                WHERE move_alert_percent IS NOT NULL AND move_alert_percent > 0`,
            ),
          ).map((row) => row.user_id),
        ),
      );

      let fired = 0;
      for (const userId of userIds) {
        try {
          const raised = await withUserContext(userId, () =>
            this.evaluateUser(userId),
          );
          if (raised) fired += 1;
        } catch (error) {
          this.logger.error(
            `Portfolio-movement evaluation failed for user ${userId}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }
      if (fired > 0) {
        this.logger.log(`Raised ${fired} portfolio-movement alert(s)`);
      }
    } catch (error) {
      this.logger.error(
        "Portfolio-movement cron failed",
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
    }
  }

  /** Evaluate one user; returns whether an alert was raised. */
  private async evaluateUser(userId: string): Promise<boolean> {
    const today = todayYMD();
    const currency = await this.reportingCurrency(userId);
    const summary = await this.portfolio.getPortfolioSummary(userId);
    const state = await this.loadState(userId);
    const movePercent =
      state?.move_alert_percent == null
        ? null
        : Number(state.move_alert_percent);

    const baseline =
      state?.baseline_value != null && state.baseline_currency != null
        ? {
            value: Number(state.baseline_value),
            currency: state.baseline_currency,
          }
        : null;

    const capturedOn = state?.baseline_captured_on ?? null;
    const baselinePositions = parseBaselinePositions(
      state?.baseline_positions ?? null,
    );

    // One dated read covers today's holdings (the snapshot the next run will
    // restate) and the baseline's (a position sold since still needs its latest
    // close). It is the very query that priced today's value, so the snapshot
    // cannot name a close the valuation did not use.
    const observations = await this.portfolio.getLatestPriceObservations([
      ...new Set([
        ...summary.holdings.map((holding) => holding.securityId),
        ...(baselinePositions ?? []).map((position) => position.securityId),
      ]),
    ]);
    const observationFor = (securityId: string): PriceObservation | null =>
      observations.get(securityId) ?? null;

    // The flow and the late-price evidence only matter when there is a
    // same-currency, dated baseline with its closes to measure a period
    // against; otherwise the decision rebaselines or withholds before reading
    // either.
    const comparable =
      baseline != null &&
      baseline.currency === currency &&
      capturedOn != null &&
      baselinePositions != null &&
      summary.totalPortfolioValue !== null;
    const baselineDate = comparable ? capturedOn : null;

    const flow =
      baselineDate === null
        ? { complete: true, value: 0 }
        : await this.externalFlow(userId, baselineDate, today, currency);

    const late =
      baselineDate === null || baselinePositions === null
        ? { complete: true, total: 0, items: [], missing: [] }
        : latePriceAdjustment(
            baselinePositions,
            baselineDate,
            observationFor,
            await this.ratesInto(
              currency,
              baselinePositions,
              summary.holdings,
              today,
            ),
          );
    if (!late.complete) {
      this.logger.warn(
        `Portfolio movement for user ${userId} not measured: a late close ` +
          `since the ${baselineDate} baseline could not be valued ` +
          `(${late.missing.join(", ")}); rebaselining`,
      );
    } else if (late.items.length > 0) {
      this.logger.log(
        `Portfolio movement for user ${userId}: ${late.items.length} late ` +
          `close(s) since the ${baselineDate} baseline restated it by ` +
          `${late.total} ${currency}`,
      );
    }

    const inputs: MovementInputs = {
      mvComplete: summary.totalPortfolioValue !== null,
      // Read only when `mvComplete`, which is when the total is known.
      mvToday: summary.totalPortfolioValue ?? 0,
      latePrice: { complete: late.complete, value: late.total },
      currency,
      baseline,
      baselineDateKnown: capturedOn != null,
      baselinePositionsKnown: baselinePositions != null,
      flow,
      movePercent,
    };
    const decision = decideMovement(inputs);

    // Do the thing, then write down what happened (A26-L28): the alert is
    // written BEFORE the baseline moves, so a failed write leaves the old
    // baseline and the next run measures the same movement again. The
    // per-day dedupe key makes that retry harmless.
    let written: unknown = null;
    // `decideMovement` replaces an undated baseline instead of comparing
    // against it, so a fired decision always has a real opening date; the
    // second arm is what proves it to the compiler, in place of a fallback
    // that would stamp today's date over a period that did not start today.
    if (decision.fire != null && baselineDate !== null) {
      const prefs = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(UserPreference).findOne({ where: { userId } }),
      );
      written = await this.dispatch.notify(
        userId,
        buildPortfolioNotification(
          decision.fire,
          currency,
          baselineDate,
          today,
          numberFormatterFor(prefs?.numberFormat, prefs?.language),
          late.items.map((item) => ({
            ...item,
            symbol:
              summary.holdings.find(
                (holding) => holding.securityId === item.securityId,
              )?.symbol ?? null,
          })),
        ),
      );
    }

    // A null `written` means another replica already wrote today's alert by
    // the dedupe key; the baseline still moves.
    if (decision.rebaselineTo != null) {
      const snapshot = snapshotPositions(summary.holdings, observationFor);
      if (snapshot === null) {
        this.logger.warn(
          `Portfolio movement baseline for user ${userId} stored without its ` +
            `closes: a held position has no dated observation`,
        );
      }
      await this.storeBaseline(
        userId,
        decision.rebaselineTo,
        currency,
        today,
        snapshot,
      );
    }
    return written != null;
  }

  /**
   * Today's rate from each baseline position's currency into the reporting
   * currency, for valuing a late close.
   *
   * Read off the holdings first -- `marketValueDefaultCurrency / marketValue` is
   * the very rate that put today's value into the reporting currency, so the
   * restatement and the valuation share one FX snapshot and the period's FX
   * move on the old close stays in the movement exactly. Only a currency no
   * priced holding carries any more (a position sold since the baseline) asks
   * the resolver, for today's date.
   */
  private async ratesInto(
    reportingCurrency: string,
    positions: readonly BaselinePosition[],
    holdings: readonly {
      currencyCode: string;
      marketValue: number | null;
      marketValueDefaultCurrency: number | null;
    }[],
    today: string,
  ): Promise<(currency: string) => number | null> {
    const rates = new Map<string, number | null>();
    for (const holding of holdings) {
      if (rates.has(holding.currencyCode)) continue;
      if (
        holding.marketValue != null &&
        holding.marketValue !== 0 &&
        holding.marketValueDefaultCurrency != null
      ) {
        rates.set(
          holding.currencyCode,
          holding.marketValueDefaultCurrency / holding.marketValue,
        );
      }
    }
    for (const { currency } of positions) {
      if (rates.has(currency)) continue;
      rates.set(
        currency,
        currency === reportingCurrency
          ? 1
          : await this.exchangeRates.getRateForDate(
              currency,
              reportingCurrency,
              today,
            ),
      );
    }
    return (currency) =>
      currency === reportingCurrency ? 1 : (rates.get(currency) ?? null);
  }

  /** The user's reporting currency, resolved through the one shared reader. */
  private async reportingCurrency(userId: string): Promise<string> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ default_currency: string | null }>(
        await manager.query(
          "SELECT default_currency FROM user_preferences WHERE user_id = $1",
          [userId],
        ),
      );
      return preferredCurrency({ defaultCurrency: rows[0]?.default_currency });
    });
  }

  private async loadState(userId: string): Promise<PortfolioStateRow | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<PortfolioStateRow>(
        await manager.query(
          `SELECT move_alert_percent, baseline_value, baseline_currency,
                  TO_CHAR(baseline_captured_on, 'YYYY-MM-DD') AS baseline_captured_on,
                  baseline_positions
             FROM notification_portfolio_state WHERE user_id = $1`,
          [userId],
        ),
      );
      return rows[0] ?? null;
    });
  }

  private async storeBaseline(
    userId: string,
    value: number,
    currency: string,
    capturedOn: string,
    positions: BaselinePosition[] | null,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO notification_portfolio_state
           (user_id, baseline_value, baseline_currency, baseline_captured_on,
            baseline_positions)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id) DO UPDATE
           SET baseline_value = $2,
               baseline_currency = $3,
               baseline_captured_on = $4,
               baseline_positions = $5::jsonb`,
        [
          userId,
          value,
          currency,
          capturedOn,
          positions === null ? null : JSON.stringify(positions),
        ],
      ),
    );
  }

  /**
   * The net cash that crossed the investment-account boundary from outside since
   * `sinceDate` (exclusive) through `today` (inclusive), in `reportingCurrency`.
   *
   * Which rows count is `loadExternalFlowSubtotals`
   * (`securities/external-flow.util.ts`), shared with the calendar's daily
   * change layer so the two surfaces cannot measure different things under one
   * name; its doc comment carries the classification and the two coarse cases
   * (INV-PORTMOVE-006).
   *
   * What is this caller's own is the rate, and it is the flow's OWN date's, not
   * the day the cron runs (INV-PORTMOVE-007). The subtotals are read per day
   * and each `(date, currency)` pair is converted through the shared resolver
   * at that date, so a Friday deposit is worth Friday's rate on a Monday run;
   * pricing a weekend's flows at Monday's close moved the whole FX difference
   * into the movement and reported it as a market return. A `(date, currency)`
   * pair with no rate makes the flow incomplete -- which withholds the movement
   * rather than shrinking it (INV-PORTMOVE-002).
   */
  private async externalFlow(
    userId: string,
    sinceDate: string,
    today: string,
    reportingCurrency: string,
  ): Promise<{ complete: boolean; value: number }> {
    const subtotals = await loadExternalFlowSubtotals(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      { userId, afterDate: sinceDate, throughDate: today, perDay: true },
    );

    const flowRows: FlowSubtotal[] = subtotals.map((row) => ({
      date: row.date,
      currency: row.currency,
      amount: row.amount,
    }));

    // One resolution per (date, currency) pair, in historical mode: the rate
    // that applied on the day the cash crossed the boundary.
    const rates = new Map<string, number | null>();
    for (const { currency, date } of flowRows) {
      const on = date ?? today;
      const key = `${currency}@${on}`;
      if (rates.has(key)) continue;
      rates.set(
        key,
        currency === reportingCurrency
          ? 1
          : await this.exchangeRates.getRateForDate(
              currency,
              reportingCurrency,
              on,
            ),
      );
    }

    const folded = foldExternalFlow(
      flowRows,
      reportingCurrency,
      (currency, date) => rates.get(`${currency}@${date ?? today}`) ?? null,
    );
    if (!folded.complete) {
      this.logger.warn(
        `Portfolio movement withheld for user ${userId}: external flow has no ` +
          `rate for ${folded.missingPairs.join(", ")}`,
      );
    }
    return { complete: folded.complete, value: folded.value };
  }
}

/**
 * The notification a fired movement raises, as a pure function of the movement,
 * the reporting currency and the two dates it spans -- so the type/severity,
 * deep link and `data` snapshot are testable without the cron. Dedupe key
 * carries the day, so at most one movement alert exists per day.
 *
 * The payload names what was measured and over which period, because a figure a
 * reader cannot reproduce is a figure they have to trust: both boundary dates
 * and all four components (`baselineValue`, `currentValue`, `externalFlow`,
 * `latePriceAdjustment`) in the one currency, with each late close named in
 * `latePrices` (security, the two close dates, and what it added). "Today" alone was wrong as often as it was right -- a Monday
 * run measures from Friday -- so the copy names the period rather than the day.
 */
export function buildPortfolioNotification(
  fire: FiredMovement,
  currency: string,
  baselineDate: string,
  today: string,
  n: NumberT = defaultNumberT,
  latePrices: ReadonlyArray<LatePrice & { symbol: string | null }> = [],
): CreateNotificationInput {
  const percent = n.formatPercentTrimmed(Math.abs(fire.changePercent));
  const moved = fire.direction === "up" ? "up" : "down";
  return {
    type: NotificationType.PORTFOLIO_MOVEMENT,
    severity: NotificationSeverity.INFO,
    title: "Investment value moved",
    message:
      `Your investments are ${moved} ${percent} from ${baselineDate} to ` +
      `${today} (excluding deposits and withdrawals). Open Monize for the details.`,
    data: {
      changePercent: fire.changePercent,
      direction: fire.direction,
      movementValue: fire.movementValue,
      baselineValue: fire.baselineValue,
      currentValue: fire.currentValue,
      externalFlow: fire.externalFlow,
      latePriceAdjustment: fire.latePriceAdjustment,
      latePrices: latePrices.map((item) => ({
        securityId: item.securityId,
        symbol: item.symbol,
        fromDate: item.fromDate,
        toDate: item.toDate,
        value: item.value,
      })),
      baselineDate,
      valuationDate: today,
      currencyCode: currency,
    },
    target: "/investments",
    dedupeKey: `portmove:${currency}:${today}`,
  };
}
