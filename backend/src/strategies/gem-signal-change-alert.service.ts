import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { getEffectiveTimezoneOfUser } from "../common/users-by-timezone.util";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { GemStrategyService } from "./gem-strategy.service";
import {
  GemAssetRef,
  GemHistoryEntryView,
  GemStrategyRef,
  GemStrategyReportView,
} from "./gem-report.types";

/**
 * How many strategies' reports we build at once. Each `getReport` materializes
 * the current period and recomputes the report, so this is CPU-bound, not
 * IO-bound; a small fan-out keeps a user with many scenarios from monopolising
 * the tick without flooding the pool.
 */
const STRATEGY_CONCURRENCY = 3;

/** A change of GEM recommendation between two periods -- risk state or target. */
type SignalChangeKind = "risk" | "allocation";

/**
 * Notifies a user when one of their GEM strategies changes its recommendation
 * between evaluation periods -- a `RISK_ON <-> RISK_OFF` move (the louder `risk`
 * event) or, within the same state, a change of target role/security (an
 * `allocation` event). See `docs/specs/gem-signal-change-notifications.md`.
 *
 * The signal is never re-evaluated here: this reuses `GemStrategyService.getReport`
 * (the one materializer, `gem-signal.service.ts`, runs inside it) and compares the
 * two latest periods of its `history`. A crossing fires once per (strategy,
 * period, kind); the dedupe key carries the period so the daily tick is
 * idempotent. A period that is not yet evaluable produces fewer than two history
 * entries and is a no-op -- never read as "no change".
 */
@Injectable()
export class GemSignalChangeAlertService {
  private readonly logger = new Logger(GemSignalChangeAlertService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly gemStrategies: GemStrategyService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Daily on weekdays, after the security-price (5 PM ET) and market-index
   * (5:10 PM ET) refreshes, so the current period is priced before we compare.
   * GEM's cadence is monthly; a daily check catches a boundary the day after it
   * becomes evaluable, and the dedupe key makes the repeated checks free.
   */
  @Cron("30 17 * * 1-5", { timeZone: "America/New_York" })
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const userIds = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) =>
          returnedRows<{ user_id: string }>(
            await manager.query("SELECT DISTINCT user_id FROM gem_strategies"),
          ).map((row) => row.user_id),
        ),
      );

      let fired = 0;
      for (const userId of userIds) {
        try {
          // The report is cut at the user's day, so the identity carries the
          // user's timezone (todayYMD() would otherwise be the server's day).
          fired += await withUserContext(userId, async () => {
            const timezone = await withScopedDb(this.dataSource, (m) =>
              getEffectiveTimezoneOfUser(m, userId),
            );
            return withUserContext(
              userId,
              () => this.evaluateUser(userId),
              timezone,
            );
          });
        } catch (error) {
          this.logger.error(
            `GEM signal-change evaluation failed for user ${userId}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }
      if (fired > 0) {
        this.logger.log(`Raised ${fired} GEM recommendation-change alert(s)`);
      }
    } catch (error) {
      this.logger.error(
        "GEM signal-change cron failed",
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
    }
  }

  /** Every strategy this user owns; returns how many alerts were raised. */
  private async evaluateUser(userId: string): Promise<number> {
    const refs = await this.gemStrategies.listStrategies(userId);
    let fired = 0;
    for (let i = 0; i < refs.length; i += STRATEGY_CONCURRENCY) {
      const batch = refs.slice(i, i + STRATEGY_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        batch.map((ref) => this.evaluateStrategy(userId, ref)),
      );
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === "fulfilled") {
          fired += outcome.value;
        } else {
          this.logger.error(
            `GEM signal-change evaluation failed for strategy ${batch[index].id}`,
            outcome.reason instanceof Error
              ? outcome.reason.stack
              : outcome.reason,
          );
        }
      }
    }
    return fired;
  }

  /** Build one strategy's report and raise an alert if its recommendation changed. */
  private async evaluateStrategy(
    userId: string,
    ref: GemStrategyRef,
  ): Promise<number> {
    const report = await this.gemStrategies.getReport(userId, "1Y", ref.id);
    const change = detectSignalChange(report);
    if (!change) return 0;

    const written = await this.dispatch.notify(
      userId,
      buildGemSignalNotification(ref, change),
    );
    return written ? 1 : 0;
  }
}

/**
 * The notification a detected change raises, as a pure function of the strategy
 * and the change -- so the type/severity mapping, the dedupe key (one row per
 * strategy, period and kind) and the `data` snapshot are testable without a
 * database or the cron plumbing.
 */
export function buildGemSignalNotification(
  ref: GemStrategyRef,
  change: SignalChange,
): CreateNotificationInput {
  return {
    type: NotificationType.GEM_SIGNAL_CHANGED,
    severity:
      change.kind === "risk"
        ? NotificationSeverity.WARNING
        : NotificationSeverity.INFO,
    title: englishTitle(change, ref.name),
    message: englishMessage(change, ref.name),
    data: {
      strategyId: ref.id,
      strategyName: ref.name,
      kind: change.kind,
      fromState: change.previous.state,
      toState: change.current.state,
      fromRole: change.previous.winner?.role ?? null,
      toRole: change.current.winner?.role ?? null,
      fromSymbol: change.previous.winner?.symbol ?? null,
      toSymbol: change.current.winner?.symbol ?? null,
      targetSecurityId: change.current.winner?.securityId ?? null,
      evaluatedOn: change.current.evaluatedOn,
    },
    target: "/reports/gem-strategy",
    dedupeKey: `gem:${ref.id}:${change.current.evaluatedOn}:${change.kind}`,
  };
}

/**
 * A stable key for a period's target, so two periods can be compared without
 * caring whether the winner is identified by security or only by role. A
 * securityless role (an unmapped leg) still compares equal to itself.
 */
function winnerKey(winner: GemAssetRef | null): string | null {
  if (!winner) return null;
  return winner.securityId ?? `role:${winner.role}`;
}

export interface SignalChange {
  kind: SignalChangeKind;
  current: GemHistoryEntryView;
  previous: GemHistoryEntryView;
}

/**
 * The recommendation change between the report's current period and the one
 * before it, or `null` when there is none, when the current period has no
 * signal yet, or with fewer than two evaluable periods.
 * A risk-state change wins over an allocation change: it always implies one, and
 * the requester wanted the state move as its own louder event.
 */
export function detectSignalChange(
  report: GemStrategyReportView,
): SignalChange | null {
  const periods = [...report.history].sort((a, b) =>
    a.evaluatedOn < b.evaluatedOn ? 1 : a.evaluatedOn > b.evaluatedOn ? -1 : 0,
  );
  if (periods.length < 2) return null;
  const [current, previous] = periods;
  // INV-GEM-NOTIFY-003 (A26-L24): only the current period's change. A current
  // period that is not evaluable yet has no signal, and the two newest history
  // rows are then an old change that was announced when it happened.
  if (!report.signal || report.signal.evaluatedOn !== current.evaluatedOn) {
    return null;
  }

  if (current.state !== previous.state) {
    return { kind: "risk", current, previous };
  }
  if (winnerKey(current.winner) !== winnerKey(previous.winner)) {
    return { kind: "allocation", current, previous };
  }
  return null;
}

/** English fallback title; the client composes the localized copy from `data`. */
function englishTitle(change: SignalChange, strategyName: string): string {
  if (change.kind === "risk") {
    const to = change.current.state === "RISK_ON" ? "risk-on" : "risk-off";
    return `${strategyName}: moved to ${to}`;
  }
  return `${strategyName}: target changed`;
}

/** English fallback body; the client composes the localized copy from `data`. */
function englishMessage(change: SignalChange, strategyName: string): string {
  if (change.kind === "risk") {
    const from = change.previous.state === "RISK_ON" ? "risk-on" : "risk-off";
    const to = change.current.state === "RISK_ON" ? "risk-on" : "risk-off";
    return `Your GEM strategy "${strategyName}" changed from ${from} to ${to}. Open Monize to review the recommendation.`;
  }
  const to =
    change.current.winner?.symbol ??
    change.current.winner?.name ??
    change.current.winner?.role ??
    "a new target";
  return `Your GEM strategy "${strategyName}" now targets ${to}. Open Monize to review the recommendation.`;
}
