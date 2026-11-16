import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";
import { ExchangeRateHistoryService } from "./exchange-rate-history.service";

/**
 * How many bounded gap fills one catch-up spends on each currency. A fill asks
 * for at most `MAX_GAP_WINDOWS` windows of up to a year, so this reaches back
 * about half a century; whatever is left is the Currencies page's button.
 */
export const RATE_HISTORY_CATCH_UP_MAX_ROUNDS = 6;

/**
 * Catch-ups still running, and the follow-up each one starts when it stored
 * rates.
 *
 * Module scope for the reason `pendingPriceWrites` gives: the thing that waits
 * is the integration helper `cleanTables`, which must not truncate `accounts`
 * or `exchange_rates` under a fill that has outlived its import or restore (a
 * deadlock reported against whichever spec ran next, bond-import in CI).
 * Nothing in `src/` waits on this; production keeps the fire-and-forget
 * behaviour.
 */
const pendingRateHistoryFills = new Set<Promise<unknown>>();

/**
 * Resolves once every catch-up started so far has finished. Settled, not
 * successful: a failed fill has also stopped touching the database.
 */
export async function settlePendingRateHistoryFills(): Promise<void> {
  // Snapshotted because a settling promise removes itself from the set.
  while (pendingRateHistoryFills.size > 0) {
    await Promise.allSettled([...pendingRateHistoryFills]);
  }
}

/**
 * Pulls the stored FX history a batch of newly written accounts needs, without
 * anyone pressing "Fill gaps in rate history".
 *
 * `backfillHistoricalRates` fetches a pair's history only while the pair holds
 * no row at all, so a currency whose today's rate is already stored (the daily
 * refresh ran after it was added, or another user of the deployment uses it)
 * never got the years the new rows reach back to (issue #2186). An import and a
 * backup restore both write such rows (issue #2226), and both run this, the
 * same fill the Currencies page's button runs, after their rows are committed.
 */
@Injectable()
export class RateHistoryCatchUpService {
  private readonly logger = new Logger(RateHistoryCatchUpService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ExchangeRateHistoryService))
    private readonly rateHistory: ExchangeRateHistoryService,
  ) {}

  /**
   * Run {@link fill} in the background, and `onStored` once it has stored at
   * least one rate (a snapshot converted before the rates existed is stale).
   * In the background because each round may spend `GAP_FILL_BUDGET_MS` on the
   * provider and the caller has already written its rows. Never rejects: a
   * failure is logged under `label` ("Post-import", "Post-restore").
   */
  start(
    userId: string,
    accountIds: readonly string[],
    label: string,
    onStored: () => void,
  ): void {
    const running = this.fill(userId, accountIds, label)
      .then((stored) => {
        if (stored > 0) onStored();
      })
      .catch((err) =>
        this.logger.warn(`${label} rate history fill failed: ${err.message}`),
      );
    pendingRateHistoryFills.add(running);
    void running.finally(() => pendingRateHistoryFills.delete(running));
  }

  /**
   * Fill the stored rate history of every foreign currency the accounts use --
   * the accounts' own and their securities' -- against the user's reporting
   * currency, over the span their data uses it. Repeated while the fill reports
   * windows left and the last round got an answer. Returns how many rates were
   * stored.
   *
   * A currency no provider carries (a custom code, a coin without a price
   * symbol) or a provider that did not answer is logged and skipped: the
   * caller's rows are correct either way, and the page still offers the fill.
   */
  async fill(
    userId: string,
    accountIds: readonly string[],
    label: string,
  ): Promise<number> {
    if (accountIds.length === 0) return 0;
    const reporting = await resolveUserDefaultCurrency(this.dataSource, userId);
    // Rows as EFFECTS: renders `it.status != 'VOID'`, because a void trade
    // records something that did not happen and puts no currency in use.
    const rows: Array<{ code: string }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT DISTINCT code FROM (
             SELECT a.currency_code AS code
               FROM accounts a
              WHERE a.id = ANY($1::UUID[]) AND a.user_id = $2
             UNION
             SELECT s.currency_code AS code
               FROM investment_transactions it
               JOIN securities s ON s.id = it.security_id
              WHERE it.account_id = ANY($1::UUID[]) AND it.user_id = $2
                AND ${investmentEffectStatusSql("it")}
           ) used
           WHERE code IS NOT NULL AND code <> $3
           ORDER BY code`,
          [accountIds, userId, reporting],
        ),
    );

    let stored = 0;
    for (const { code } of rows) {
      for (let round = 0; round < RATE_HISTORY_CATCH_UP_MAX_ROUNDS; round++) {
        try {
          const fill = await this.rateHistory.fillRateGaps(userId, code);
          stored += fill.stored;
          const answered = fill.windowsFetched - fill.windowsUnanswered;
          if (fill.windowsRemaining === 0 || answered === 0) break;
        } catch (err) {
          this.logger.warn(
            `${label} rate history fill for ${code}->${reporting} stopped: ${err.message}`,
          );
          break;
        }
      }
    }
    return stored;
  }
}
