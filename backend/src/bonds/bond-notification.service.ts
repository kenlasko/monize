import { HttpException, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { addDaysYMD } from "../common/date-utils";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  BOND_BENCHMARK_FRESH_DAYS,
  BOND_LOOKBACK_DAYS,
  BenchmarkObservation,
  BondPayout,
  MaturityCandidate,
  affectedSeriesOf,
  benchmarkPublishedNotification,
  buildInterestNotification,
  buildMaturitySoonNotification,
  buildRedemptionUnbookedNotification,
  interestCandidates,
  maturitySoonCandidates,
  missingDataNotification,
  payoutOf,
  readsBenchmarkForLaterPeriod,
  rateResetNotifications,
  unbookedCandidates,
  unknownPayout,
} from "./bond-notification-events";
import {
  BondDataInconsistentError,
  BondDataNotFoundError,
} from "./bond-errors";
import { BondHoldingsService } from "./bond-holdings.service";
import {
  BondValuationService,
  SecurityValuation,
  financialTodayOf,
} from "./bond-valuation.service";
import { BondEngineError } from "./engine/bond-engine";

/** Users read per keyset page of the fan-out. */
const USER_BATCH = 200;

/**
 * Raises the bond notifications of `docs/specs/bond-notifications.md` from the
 * engine's valuation of every bond-linked security a person holds. It reads
 * stored terms, observations and the ledger and writes nothing but notification
 * rows, through `NotificationDispatchService.notify` after every read has
 * committed (INV-BONDNOTIFY-001, INV-BOND-008). The event rules are pure
 * (`bond-notification-events.ts`); a second replica or a re-run is stopped by the
 * per-user dedupe key in `NotificationService.create` (INV-BONDNOTIFY-002).
 */
@Injectable()
export class BondNotificationService {
  private readonly logger = new Logger(BondNotificationService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly valuation: BondValuationService,
    private readonly holdings: BondHoldingsService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Daily after the bond jobs it reads (benchmarks 06:25, prices 06:45, series
   * 07:15). The timezone is spelled as a literal: cron-doc.spec.ts reads it from
   * the decorator.
   */
  @Cron("40 7 * * *", { timeZone: "Europe/Warsaw" })
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let raised = 0;
      let after: string | null = null;
      for (;;) {
        const userIds = await this.userPage(after);
        if (userIds.length === 0) break;
        for (const userId of userIds) {
          try {
            raised += await this.evaluateUser(userId);
          } catch (error) {
            this.logger.warn(
              `Bond notifications failed for user ${userId}: ${describe(error)}`,
            );
          }
        }
        after = userIds[userIds.length - 1];
        if (userIds.length < USER_BATCH) break;
      }
      if (raised > 0) {
        this.logger.log(`Raised ${raised} bond notification(s)`);
      }
    } catch (error) {
      this.logger.error(`Bond notification cron failed: ${describe(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** The next page of owners of an active bond-linked security, by user id. */
  private userPage(after: string | null): Promise<string[]> {
    return withSystemContext(() =>
      withScopedDb(this.dataSource, async (m) =>
        returnedRows<{ user_id: string }>(
          await m.query(
            `SELECT DISTINCT user_id FROM securities
              WHERE bond_program_id IS NOT NULL
                AND is_active = true
                AND ($1::uuid IS NULL OR user_id > $1::uuid)
              ORDER BY user_id
              LIMIT $2`,
            [after, USER_BATCH],
          ),
        ).map((row) => row.user_id),
      ),
    );
  }

  /** Every event of one person, dispatched after the reads; returns how many rows were written. */
  async evaluateUser(userId: string): Promise<number> {
    return withUserContext(userId, async () => {
      const today = await this.financialToday(userId);
      const securityIds = await this.activeSecurities(userId);

      const events: CreateNotificationInput[] = [];
      const valuations: SecurityValuation[] = [];
      for (const securityId of securityIds) {
        try {
          const found = await this.eventsOfSecurity(userId, securityId, today);
          valuations.push(found.valuation);
          events.push(...found.events);
        } catch (error) {
          this.logger.warn(
            `Bond notifications failed for security ${securityId}: ${describe(error)}`,
          );
        }
      }
      try {
        events.push(...(await this.benchmarkEvents(valuations, today)));
      } catch (error) {
        this.logger.warn(
          `Bond benchmark notifications failed for user ${userId}: ${describe(error)}`,
        );
      }

      // Every read above has committed: `notify` writes the row in its own
      // transaction and awaits the push and email fan-out, an external side
      // effect that must never run inside one.
      let written = 0;
      for (const event of events) {
        try {
          if (await this.dispatch.notify(userId, event)) written += 1;
        } catch (error) {
          this.logger.warn(
            `Bond notification ${event.dedupeKey ?? event.type} failed for user ${userId}: ${describe(error)}`,
          );
        }
      }
      return written;
    });
  }

  private async eventsOfSecurity(
    userId: string,
    securityId: string,
    today: string,
  ): Promise<{
    valuation: SecurityValuation;
    events: CreateNotificationInput[];
  }> {
    const valuation = await this.valuation.valueSecurity(
      userId,
      securityId,
      today,
    );
    const events: CreateNotificationInput[] = [];
    const missing = missingDataNotification(valuation);
    if (missing) events.push(missing);
    // A ledger the lots cannot be derived from has no group to evaluate.
    if (valuation.refusal !== null) return { valuation, events };

    for (const candidate of maturitySoonCandidates(valuation, today)) {
      events.push(
        buildMaturitySoonNotification(
          valuation,
          candidate,
          await this.payoutOf(userId, securityId, candidate),
        ),
      );
    }
    for (const candidate of unbookedCandidates(valuation)) {
      events.push(
        buildRedemptionUnbookedNotification(
          valuation,
          candidate,
          await this.payoutOf(userId, securityId, candidate),
        ),
      );
    }
    events.push(...rateResetNotifications(valuation, today));

    // Item 2 reads the valuation as of the start of its look-back window: the
    // flows after that day, today's and those of a day the cron missed. Its own
    // failure drops only item 2, never the events of today's valuation above.
    let windowStart: SecurityValuation;
    try {
      windowStart = await this.valuation.valueSecurity(
        userId,
        securityId,
        addDaysYMD(today, -BOND_LOOKBACK_DAYS),
      );
    } catch (error) {
      this.logger.warn(
        `Bond interest notifications failed for security ${securityId}: ${describe(error)}`,
      );
      return { valuation, events };
    }
    if (windowStart.refusal === null) {
      for (const candidate of interestCandidates(windowStart, today)) {
        if (
          candidate.accountId !== null &&
          (await this.interestBooked(
            userId,
            securityId,
            candidate.accountId,
            candidate.paymentDate,
          ))
        ) {
          continue;
        }
        events.push(buildInterestNotification(valuation, candidate));
      }
    }
    return { valuation, events };
  }

  /**
   * The engine's split of the group's redemption on its maturity date. A refusal
   * (the split's own, a ledger or terms the engine cannot use) is a payout of
   * nulls carrying its code, never zero; anything else is a failure to retry.
   */
  private async payoutOf(
    userId: string,
    securityId: string,
    candidate: MaturityCandidate,
  ): Promise<BondPayout> {
    if (candidate.accountId === null) return unknownPayout("ACCOUNT_UNKNOWN");
    try {
      return payoutOf(
        await this.holdings.redemptionSplit(
          userId,
          securityId,
          candidate.accountId,
          candidate.instrumentId,
          candidate.maturityDate,
          candidate.quantity,
        ),
      );
    } catch (error) {
      const code = refusalCodeOf(error);
      if (code === null) throw error;
      return unknownPayout(code);
    }
  }

  /** Item 5, per benchmark a held OPEN lot reads: its newest observation, when stored recently. */
  private async benchmarkEvents(
    valuations: readonly SecurityValuation[],
    today: string,
  ): Promise<CreateNotificationInput[]> {
    const ids = new Set<string>();
    for (const valuation of valuations) {
      for (const lot of valuation.lots) {
        const { rateRule } = lot.valuation;
        if (
          lot.valuation.status === "OPEN" &&
          rateRule.benchmarkId !== null &&
          readsBenchmarkForLaterPeriod(rateRule)
        ) {
          ids.add(rateRule.benchmarkId);
        }
      }
    }
    const events: CreateNotificationInput[] = [];
    for (const benchmarkId of [...ids].sort()) {
      const observation = await this.freshObservation(benchmarkId);
      if (observation === null) continue;
      const event = benchmarkPublishedNotification(
        observation,
        affectedSeriesOf(valuations, benchmarkId, today),
      );
      if (event) events.push(event);
    }
    return events;
  }

  /** The newest stored observation of a benchmark when it was stored within the freshness window. */
  private freshObservation(
    benchmarkId: string,
  ): Promise<BenchmarkObservation | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{
        kind: "STEP" | "MONTHLY";
        publisher: string;
        unit: string;
        observation_date: string;
        value: string;
        published_on: string | null;
        fresh: boolean;
      }>(
        await m.query(
          `SELECT s.kind,
                  s.publisher,
                  s.unit,
                  TO_CHAR(v.observation_date, 'YYYY-MM-DD') AS observation_date,
                  v.value::text AS value,
                  TO_CHAR(v.published_on, 'YYYY-MM-DD') AS published_on,
                  (v.retrieved_at >= NOW() - ($2::int * INTERVAL '1 day')) AS fresh
             FROM benchmark_values v
             JOIN benchmark_series s ON s.code = v.benchmark_code
            WHERE v.benchmark_code = $1
            ORDER BY v.observation_date DESC
            LIMIT 1`,
          [benchmarkId, BOND_BENCHMARK_FRESH_DAYS],
        ),
      );
      const row = rows[0];
      if (!row || !row.fresh) return null;
      return {
        benchmarkId,
        publisher: row.publisher,
        // A monthly observation is stored on the first day of its month.
        observation:
          row.kind === "MONTHLY"
            ? row.observation_date.slice(0, 7)
            : row.observation_date,
        value: row.value,
        unit: row.unit,
        publishedOn: row.published_on,
      };
    });
  }

  /** The person has already booked the day's interest in this account. */
  private interestBooked(
    userId: string,
    securityId: string,
    accountId: string,
    date: string,
  ): Promise<boolean> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{ id: string }>(
        await m.query(
          `SELECT id FROM investment_transactions
            WHERE user_id = $1
              AND security_id = $2
              AND account_id = $3
              AND action = 'INTEREST'
              AND status != 'VOID'
              AND transaction_date = $4::date
            LIMIT 1`,
          [userId, securityId, accountId, date],
        ),
      );
      return rows.length > 0;
    });
  }

  private activeSecurities(userId: string): Promise<string[]> {
    return withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT id FROM securities
            WHERE user_id = $1
              AND bond_program_id IS NOT NULL
              AND is_active = true
            ORDER BY id`,
          [userId],
        ),
      ).map((row) => row.id),
    );
  }

  /** The person's own calendar day, the one rule the bond module shares. */
  private financialToday(userId: string): Promise<string> {
    return withScopedDb(this.dataSource, (m) => financialTodayOf(m, userId));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The code of an error that is the engine's or the ledger's refusal to give a
 * figure (the 400 and 422 of the holdings service, the bond data and engine
 * errors); null for anything else, which is a failure and not an answer.
 */
function refusalCodeOf(error: unknown): string | null {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status !== 400 && status !== 422) return null;
    const body = error.getResponse();
    const code =
      typeof body === "object" && body !== null
        ? (body as { errorCode?: unknown }).errorCode
        : undefined;
    return typeof code === "string" ? code : "REFUSED";
  }
  if (
    error instanceof BondDataNotFoundError ||
    error instanceof BondDataInconsistentError ||
    error instanceof BondEngineError
  ) {
    return error.code;
  }
  return null;
}
