import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource, In, LessThanOrEqual } from "typeorm";
import { BalanceThresholdAlertService } from "../notification-center/balance-threshold-alert.service";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { NON_VOID_INVESTMENT_STATUS } from "../securities/investment-row-effects.util";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import {
  acquisitionCost,
  baseInvestmentAction,
  MARKET_PRICED_TRADE_ACTIONS,
} from "../securities/investment-replay.util";
import { Security } from "../securities/entities/security.entity";
import { invalidatePortfolioSummary } from "../securities/portfolio-summary-memo";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  RateIndex,
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { FxAggregate } from "../common/fx-aggregate";
import { roundMoney } from "../common/round.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  SeriesFetchOptions,
  SeriesRateGap,
  computeWithRateFill,
} from "./series-rate-fill";
import {
  applyActionToQuantity,
  INVESTMENT_REPLAY_ORDER,
  INVESTMENT_REPLAY_ORDER_SQL,
} from "../securities/investment-replay.util";
import {
  UNFILTERED_INVESTMENT_SCOPE_SQL,
  resolveInvestmentScopeAccountIds,
} from "../securities/investment-scope.util";
import { addDaysYMD, formatDateYMDLocal, todayYMD } from "../common/date-utils";
import { enumerateDaysYMD, monthEndSampleDates } from "./series-dates.util";
import { loadFirstInvestmentDate } from "./investment-inception.util";
import { positionCloseAsOf, PricePoint } from "./position-price.util";
import {
  buildDailyInvestmentsKey,
  dailyInvestmentsInFlight,
} from "./daily-investments-in-flight";
import { preferredCurrency } from "../common/default-currency.util";
import {
  DateColumn,
  DailyCashBalanceRow,
  EarliestRow,
  FirstMonthRow,
  FirstMonthTradeRow,
  InvestmentEarliestRow,
  MonthlyBalanceRow,
  MonthlyCashBalanceRow,
  MonthlySnapshotRow,
  NumericColumn,
  ReplayTransactionRow,
  ScopedInvestmentAccountRow,
  StoredPriceRow,
  TransactionPriceRow,
} from "./net-worth-rows";
import {
  LEDGER_MOVEMENT_PREDICATE,
  ledgerMovementPredicate,
} from "../common/ledger-balance.sql";

const LIABILITY_TYPES: AccountType[] = [
  AccountType.CREDIT_CARD,
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
];

/**
 * Joint accounts to include in a grantee's net worth (joint-accounts spec,
 * N1). Built by the HTTP controller from the caller's active joint grants
 * MINUS their delegate_net_worth_exclusions -- inclusion here IS the
 * authorization and the preference, so the service applies no further
 * filtering (in particular, the OWNER's exclude_from_net_worth flag governs
 * the owner's view only and is deliberately not consulted for these rows).
 * Absent (undefined) everywhere else -- AI tools, internal calls -- which
 * keeps every existing path byte-identical.
 */
export interface JointNetWorthScope {
  accounts: Array<{ accountId: string; ownerUserId: string }>;
}

/**
 * Whether the investment valuation walks this account's LEDGER CASH.
 *
 * The cash sleeve and the standalone investment account that predates the pair
 * hold cash the series adds to market value; a brokerage row holds positions,
 * and its own ledger rows are not valued. Written once because it is a boundary,
 * not a filter: any figure measured against this series -- a period's external
 * flow above all -- has to be drawn around the same accounts, or money moves
 * across a line the valuation cannot see and the difference reads as
 * performance (`docs/specs/portfolio-period-result.md` section 6).
 */
export function isValuationCashAccount(account: {
  account_type: string;
  account_sub_type: string | null;
}): boolean {
  return (
    account.account_sub_type === "INVESTMENT_CASH" ||
    (account.account_type === "INVESTMENT" && !account.account_sub_type)
  );
}

/**
 * One day of `GET /net-worth/investments-daily`: the scope's market value plus
 * cash at the close of that calendar day, in the reporting currency.
 *
 * Three completeness bits, for three different repairs. `fxComplete` says every
 * component converted; `pricesComplete` says every position the scope held that
 * day had an accepted close on or before it; `cashComplete` says every cash
 * account in the scope produced a balance for the day. A day can be short of any
 * of them, and the reader who has to fix it needs to know which -- a missing rate
 * is fixed in Currencies, a missing price by entering one for the security, and a
 * cash account with no balance for a day it was asked for is a defect to report
 * rather than a zero balance to draw (#1389).
 *
 * `value` is NOT withheld when `pricesComplete` is false. It is a subtotal on
 * such a day, which `docs/financial-calculation-contract.md` section 1 says a
 * field named like a total should not carry; making it null is a behaviour
 * change to four charts and is reported as its own proposal (task R1 of the
 * calendar-view plan). Until then a consumer that displays this value MUST read
 * the flags: `pricesComplete === false` withholds, and absent means an older
 * backend said nothing rather than that the day was complete.
 */
export interface DailyInvestmentValue {
  date: string;
  /**
   * The scope's value at that close. A subtotal when either completeness bit is
   * false -- read them before printing it under a total's caption.
   */
  value: number;
  /**
   * `IV(t)`: the INVESTED part of that same close -- the securities, without the
   * cash beside them. `value` is this plus the scope's ledger cash.
   *
   * A component of the value already folded here, not a second valuation: the
   * positions are the same replay, priced from the same accepted closes and
   * converted at the same day's rate. The invested part's P&L and time-weighted
   * return are measured over it, because cash held in an investment account is
   * not an investment (`docs/specs/portfolio-period-result.md` section 10,
   * INV-PORTRESULT-002), and the investment charts plot it for the same reason.
   *
   * The same subtotal rule as `value`: read `pricesComplete` and `fxComplete`
   * (never `cashComplete` -- no cash is in here) before printing it as a total.
   */
  securitiesValue: number;
  /** False when a component could not be converted; see missingRatePairs. */
  fxComplete: boolean;
  /** "USD->EUR" for each pair with no available rate. */
  missingRatePairs: string[];
  /**
   * False when a position held at the close of this day had no accepted price
   * on or before it, so its market value is unknown rather than zero.
   */
  pricesComplete: boolean;
  /** The securities behind `pricesComplete: false`, so a reader can price them. */
  unpricedSecurityIds: string[];
  /**
   * False when a cash account in the scope produced no balance for this day, so
   * its contribution is unknown rather than zero. The per-day balance query
   * already carries the opening balance and everything dated before the window,
   * so a row it did not produce for a day it was asked for is missing data.
   */
  cashComplete: boolean;
  /** The accounts behind `cashComplete: false`. */
  unknownCashAccountIds: string[];
}

/**
 * What one day of the daily investment fold was valued from, recorded by the
 * fold itself (`getDailyInvestmentPositions`). The intraday chart values a past
 * day's bars from these rather than from today's holdings and balances
 * (`docs/specs/intraday-historical-positions.md`, INV-INTRADAY-001).
 */
export interface DailyPositions {
  date: string;
  /** securityId -> shares held at this day's close, summed over the scope. */
  quantities: Map<string, number>;
  /**
   * securityId -> the accepted close on or before this day, in the security's
   * currency; `null` when nothing priced the position (`pricesComplete`).
   */
  closes: Map<string, number | null>;
  /**
   * securityId -> the position's value at that close in the display currency,
   * the component the day's `securitiesValue` was summed from; `null` when it
   * could not be priced or converted.
   */
  closeValues: Map<string, number | null>;
  /**
   * Cash currency -> the balance held at this day's close, over the scope's
   * cash accounts that have a balance for the day (`cashComplete`).
   */
  cashByCurrency: Map<string, number>;
}

export interface DailyInvestmentsWithPositions {
  series: DailyInvestmentValue[];
  /** One entry per day of `series`, same order. */
  positions: DailyPositions[];
  /** Every security the replay touched, keyed by id. */
  securities: Map<string, Security>;
}

/**
 * `monthEnd` samples the daily fold on the window's first day, each month-end
 * inside it and its last day (`monthEndSampleDates`), so a long-range chart
 * opens and closes on the closes its figures are measured between. `monthly`
 * is the older month-bucket replay.
 */
export type InvestmentBreakdownGranularity = "daily" | "monthly" | "monthEnd";

/**
 * One stacked band on the Portfolio Value Over Time "by security" chart. A
 * band is either an individual held security, the rolled-up "other" bucket of
 * smaller holdings beyond the top-N cutoff, or the aggregate cash band. Only
 * securities carry `symbol`/`name`; `cash` and `other` are labelled on the
 * client so their copy stays localized.
 */
export interface InvestmentBreakdownSeries {
  /** securityId for a real holding, or the sentinel "cash" / "other". */
  key: string;
  type: "security" | "cash" | "other";
  symbol: string | null;
  name: string;
}

export interface InvestmentBreakdownPoint {
  /** YYYY-MM-DD; the month-first date for monthly granularity. */
  date: string;
  /** Sum of every band's value at this point (in the display currency). */
  total: number;
  /** Per-series value keyed by {@link InvestmentBreakdownSeries.key}. */
  values: Record<string, number>;
  /**
   * False when a cash account in the scope produced no balance for this point,
   * so the cash band -- and therefore `total` -- is short a component whose
   * value is unknown rather than zero. Read as `=== false`: an absent flag is
   * an older backend saying nothing, which is no information (#1389).
   */
  cashComplete: boolean;
  /** The accounts behind `cashComplete: false`. */
  unknownCashAccountIds: string[];
  /**
   * False when a security held at this point had no accepted close on or before
   * its valuation date. Its band is missing entirely -- unknown, not zero -- so
   * `total` here is a subtotal of the bands that could be valued. Mirrors
   * {@link DailyInvestmentValue.pricesComplete}; read as `=== false`.
   */
  pricesComplete: boolean;
  /** The securities behind `pricesComplete: false`, so a reader can price them. */
  unpricedSecurityIds: string[];
  /**
   * `"USD->EUR"` for each pair THIS point could not convert. The
   * response-level `missingRatePairs` is the union over the window, which
   * cannot say which dates to repair; this one dates each pair (#1389).
   */
  missingRatePairs: string[];
}

export interface InvestmentBreakdown {
  granularity: InvestmentBreakdownGranularity;
  currency: string;
  series: InvestmentBreakdownSeries[];
  points: InvestmentBreakdownPoint[];
  /**
   * False when at least one component could not be converted into `currency`
   * because no exchange rate was available for its pair, which makes every
   * `total` here a subtotal of what did convert.
   *
   * A missing rate used to be applied as 1:1, so a consumer had no way to tell
   * a complete figure from a wrong one (audit P5-009). See
   * `docs/specs/fx-conversion-completeness.md` -- stage 2 makes the totals
   * themselves nullable.
   */
  fxComplete: boolean;
  /** `"USD->EUR"` for each pair with no available rate; empty when complete. */
  missingRatePairs: string[];
}

/**
 * Account recomputes still running. Most callers start `recalculateAccount`
 * without awaiting it (the post-import pass, account edits, the debounce
 * timer), so a test teardown that truncates `transactions` can meet one
 * mid-read: the TRUNCATE's exclusive lock and the recompute's share locks are
 * taken in opposite orders, and Postgres reports a deadlock against whichever
 * spec runs next. Same arrangement as `pendingHistoryWrites` in
 * action-history.service.ts: nothing in `src/` waits on this set.
 */
const pendingAccountRecalcs = new Set<Promise<unknown>>();

/**
 * Resolves once every account recompute started so far has finished. Call it
 * before truncating the tables a recompute reads. Settled, not successful: a
 * failed recompute has also stopped touching the database.
 */
export async function settlePendingAccountRecalcs(): Promise<void> {
  // Snapshotted because a settling promise removes itself from the set.
  while (pendingAccountRecalcs.size > 0) {
    await Promise.allSettled([...pendingAccountRecalcs]);
  }
}

@Injectable()
export class NetWorthService {
  private readonly logger = new Logger(NetWorthService.name);
  private readonly recalcTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private static readonly RECALC_DEBOUNCE_MS = 2000;

  /**
   * How long a snapshot may lag its account's last change before the sweep
   * recomputes it -- measured from the change to *now*, not from the change to
   * the previous snapshot.
   *
   * The distinction is load-bearing (review MZ-1242-R5). The sweep fires when
   * `a.updated_at > s.computed_at AND a.updated_at <= NOW() - grace`: the
   * account changed after its snapshot, and that change is now older than the
   * grace, so the debounce timer had ample time and clearly did not run.
   * Expressing the grace as a required distance *between the change and the old
   * snapshot* instead (`a.updated_at > s.computed_at + grace`) is a permanent
   * blind spot: a change one minute after the snapshot never satisfies it, so a
   * lost debounce for a manual-price edit -- which moves no balance and touches
   * only `updated_at` -- would never be recovered.
   *
   * The grace is comfortably longer than the debounce plus a slow recalc, so
   * the sweep does not race the timer that is about to do the same work, and
   * repeated edits keep pushing `updated_at` forward so it waits until the most
   * recent change has settled.
   */
  private static readonly STALE_SNAPSHOT_GRACE_MS = 10 * 60 * 1000;

  /** Accounts recomputed per sweep, so a broken deployment cannot melt the pool. */
  private static readonly STALE_SWEEP_BATCH = 200;

  constructor(
    private dataSource: DataSource,
    // The balance-invalidation seam also drives balance-threshold crossings.
    // Optional + forwardRef: the edge is on a require cycle, and a test harness
    // that omits NotificationsModule simply skips the alert rather than failing
    // to construct.
    @Optional()
    @Inject(forwardRef(() => BalanceThresholdAlertService))
    private balanceAlerts?: BalanceThresholdAlertService,
    // The read-path FX fill (see `computeWithRateFill`). Optional + forwardRef
    // for the same two reasons: CurrenciesModule reaches back here through
    // SecuritiesModule, and a harness that omits it simply reports the rates as
    // missing, which is what the series did before the fill existed.
    @Optional()
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRates?: ExchangeRateService,
  ) {}

  /**
   * A series read that fills its own exchange-rate gaps; see
   * `series-rate-fill.ts` for what that means and what it refuses to do.
   *
   * The gap it closes: the daily refresh writes today only and
   * `backfillHistoricalRates` skips a pair that has any row at all, so a user
   * who bought their first EUR holding in June has no EUR->PLN observation for
   * January through May and every chart point in that span reports the pair as
   * missing. Nothing is wrong with the data path; nobody ever asked the
   * provider. A read may ask, once, for the months its own diagnostics name.
   */
  private computeWithRateFill<R>(
    compute: () => Promise<R>,
    gapsOf: (result: R) => ReadonlyArray<SeriesRateGap>,
    options?: SeriesFetchOptions,
  ): Promise<R> {
    return computeWithRateFill(
      this.exchangeRates,
      compute,
      gapsOf,
      options,
      this.logger,
    );
  }

  /**
   * One raw statement in its own short scoped transaction -- the RLS-compliant
   * equivalent of the autocommit `dataSource.query` this service used before
   * the migration. Reporting reads here are independent single statements, so
   * each gets its own tenant transaction rather than one long-held connection.
   */
  private scopedQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
    return withScopedDb(this.dataSource, (m) => m.query(sql, params));
  }

  /**
   * Debounced trigger for recalculating a single account's net worth snapshots.
   *
   * The timer lives in this process's memory, so it is a latency optimization and
   * nothing more: a pod killed in the two seconds before it fires, or a recalc
   * that throws, loses the work with only a `warn` to show for it, and the
   * snapshots then disagree with the ledger until something else happens to
   * touch the account (audit DR-04-03). `sweepStaleSnapshots` is what makes that
   * recoverable -- it finds the disagreement in the data rather than needing a
   * queue entry that the same crash would have lost.
   */
  triggerDebouncedRecalc(accountId: string, userId: string): void {
    // INV-CACHE-001: this is the seam every balance-moving write passes through
    // after it commits, so it is where the in-process portfolio valuation is
    // forgotten too. Immediately, not on the debounced timer: the memoized
    // summary is wrong the moment the write commits, and the page reloading
    // after a trade arrives long before the two seconds are up.
    invalidatePortfolioSummary(userId);

    const key = `${userId}:${accountId}`;
    const existing = this.recalcTimers.get(key);
    if (existing) clearTimeout(existing);

    // Several callers trigger this from *inside* a `withScopedDb` block (see
    // TransactionSplitService.createSplits). A timer created there would
    // inherit that block's EntityManager through the scoped-manager ALS, and
    // fire seconds later -- long after the transaction committed and its
    // connection went back to the pool -- so every query in the recalc would
    // run on a dead manager. Registering the timer outside the active manager
    // makes the recalc open its own transaction, which is what it wants
    // anyway: it is a background job, not part of the caller's write. The
    // identity context (userId) lives in a different ALS and is preserved.
    runOutsideActiveScopedManager(() =>
      this.recalcTimers.set(
        key,
        setTimeout(() => {
          this.recalcTimers.delete(key);
          this.recalculateAccount(userId, accountId).catch((err) =>
            this.logger.warn(
              `Net worth recalc failed for account ${accountId}: ${err.message}`,
            ),
          );
          // The same post-commit seam drives balance-threshold crossings
          // (docs/specs/balance-threshold-notifications.md). Independent of the
          // recalc -- it reads the account's committed balance directly -- and
          // isolated so a notification failure never affects the recalc.
          this.balanceAlerts
            ?.evaluateAccounts(userId, [accountId])
            .catch((err) =>
              this.logger.warn(
                `Balance-threshold evaluation failed for account ${accountId}: ${err.message}`,
              ),
            );
        }, NetWorthService.RECALC_DEBOUNCE_MS),
      ),
    );
  }

  /**
   * Registered in `pendingAccountRecalcs` before it is handed back, so a
   * teardown can tell a recompute nobody awaited is still running.
   */
  recalculateAccount(userId: string, accountId: string): Promise<void> {
    const work = this.recalculateAccountNow(userId, accountId);
    pendingAccountRecalcs.add(work);
    // `finally` keeps the returned promise's own settlement untouched.
    return work.finally(() => pendingAccountRecalcs.delete(work));
  }

  private async recalculateAccountNow(
    userId: string,
    accountId: string,
  ): Promise<void> {
    // The same invalidation as the debounced seam, for the callers that
    // recompute an account directly instead of going through it.
    invalidatePortfolioSummary(userId);
    await withScopedDb(this.dataSource, async (m) => {
      // The lock first, then every read the snapshots are derived from, then the
      // delete-and-reinsert -- all in this transaction.
      //
      // Previously the monthly sums were read in one autocommit transaction and
      // written in another. Under READ COMMITTED that is two statement snapshots:
      // a transaction committing between them produced snapshots that did not
      // include it, permanently, until something else triggered a recalc. Two
      // concurrent recalcs of the same account were worse -- whichever wrote
      // second won, and it might be the one that read first, so the newer data
      // lost. Same protocol as every other absolute recomputation here: advisory
      // and row locks before the read they protect (see common/db/locks.ts).
      await lockAccountsForBalanceWrite(m, [accountId], userId);

      const account = await m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      });
      if (!account) return;

      await this.recalculateLockedAccount(userId, account);
    });
  }

  /**
   * Recompute snapshots that no longer agree with their account.
   *
   * The debounce timer is process memory, so every way it can be lost -- a pod
   * killed inside the two-second window, a recalc that throws, a rolling deploy
   * -- leaves snapshots that disagree with the ledger and nothing that will ever
   * notice. A durable work queue would not help: the crash that loses the timer
   * loses the enqueue too, unless the enqueue joins the caller's transaction, and
   * then every write path has to know about net worth.
   *
   * So the staleness is *derived* rather than recorded. Every write that can
   * change a snapshot also touches the account row in the same transaction --
   * usually a `current_balance` delta, and for the one snapshot-only change that
   * moves no balance (a past-dated row shifted to another past month, so the
   * running total is unchanged) an explicit `AccountsService.touchAccount`.
   * Either way `accounts.updated_at` advances, so it is a timestamp the account
   * itself keeps -- and the snapshots are a delete-and-reinsert, so their
   * `updated_at` is when they were last computed. An account whose row is newer
   * than its own snapshots, and whose change is now older than the grace
   * period, was missed (see `STALE_SNAPSHOT_GRACE_MS` for why the grace is an
   * age of the change, not a distance from the old snapshot -- MZ-1242-R5).
   *
   * This is the idempotent-predicate mechanism from `docs/cron-jobs.md`: two
   * replicas racing the sweep recompute the same accounts from scratch, under the
   * per-account lock, and the loser's work is simply redundant. Accounts with no
   * snapshots at all are deliberately not swept -- there is nothing to compare
   * against, and including them would recompute every empty account forever.
   *
   * The lost timer carried two jobs, so the sweep recovers both halves of the
   * seam: after the recompute it re-runs the balance-threshold evaluation the
   * timer would have run (docs/specs/balance-threshold-notifications.md).
   * Re-evaluating is safe because the crossing is a durable latch flipped by a
   * compare-and-set on `accounts.low_alert_armed` / `high_alert_armed`: an
   * account whose timer did fire, or that a racing replica already evaluated,
   * finds the latch already in the state its balance implies and raises
   * nothing. The two halves are isolated from each other exactly as on the
   * timer -- a notification failure never stops the recompute or the sweep,
   * and a failed recompute does not skip the evaluation, which reads the
   * account's committed balance rather than its snapshots.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepStaleSnapshots(): Promise<void> {
    try {
      const stale = await withSystemContext(() =>
        withScopedDb(this.dataSource, (m) =>
          m.query(
            `SELECT a.user_id, a.id AS account_id
               FROM accounts a
               JOIN (
                 SELECT account_id, MAX(updated_at) AS computed_at
                   FROM monthly_account_balances
                  GROUP BY account_id
               ) s ON s.account_id = a.id
              WHERE a.updated_at > s.computed_at
                AND a.updated_at <= NOW() - ($1::text || ' milliseconds')::interval
              ORDER BY a.updated_at
              LIMIT $2`,
            [
              String(NetWorthService.STALE_SNAPSHOT_GRACE_MS),
              NetWorthService.STALE_SWEEP_BATCH,
            ],
          ),
        ),
      );

      if (stale.length === 0) return;

      this.logger.log(
        `Recomputing ${stale.length} account(s) whose net-worth snapshots fell behind`,
      );
      if (stale.length === NetWorthService.STALE_SWEEP_BATCH) {
        // Say so rather than letting a truncated pass read as "all caught up".
        this.logger.warn(
          `Stale snapshot sweep hit its batch limit of ${NetWorthService.STALE_SWEEP_BATCH}; more remain for the next pass`,
        );
      }

      for (const row of stale as Array<{
        user_id: string;
        account_id: string;
      }>) {
        try {
          await withUserContext(row.user_id, async () => {
            try {
              await this.recalculateAccount(row.user_id, row.account_id);
            } catch (err) {
              this.logger.warn(
                `Stale snapshot recompute failed for account ${row.account_id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
            // The other half of the lost timer (see the doc comment). Its own
            // try/catch, as on the timer, so a notification failure never
            // affects the recompute or stops the sweep.
            try {
              await this.balanceAlerts?.evaluateAccounts(row.user_id, [
                row.account_id,
              ]);
            } catch (err) {
              this.logger.warn(
                `Balance-threshold evaluation failed for account ${row.account_id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          });
        } catch (err) {
          // withUserContext itself refused the owner id (it validates it), so
          // neither half ran; say both, not just the recompute.
          this.logger.warn(
            `Stale snapshot sweep skipped account ${row.account_id}: its owner ` +
              `id was refused, so neither the snapshot recompute nor the ` +
              `balance-threshold evaluation ran: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Stale snapshot sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Dispatch for an account whose row is already locked inside the ambient
   * transaction. The two branches' own `withScopedDb`/`scopedQuery` calls join it.
   */
  private async recalculateLockedAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    if (this.isBrokerageOrStandaloneInvestment(account)) {
      await this.recalculateBrokerageAccount(userId, account);
    } else {
      await this.recalculateRegularAccount(userId, account);
    }
  }

  async recalculateAllAccounts(userId: string): Promise<void> {
    // Include closed accounts - they have important historical balances
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId },
      }),
    );
    await Promise.all(
      accounts.map(async (account) => {
        try {
          // One locked transaction per account, exactly as the single-account
          // path: a full-user rebuild racing an ordinary edit must not write a
          // snapshot derived from rows that changed while it was reading.
          await this.recalculateAccount(userId, account.id);
        } catch (err) {
          this.logger.warn(
            `Failed to recalculate account ${account.id}: ${err.message}`,
          );
        }
      }),
    );
  }

  async ensurePopulated(userId: string): Promise<void> {
    const count = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonthlyAccountBalance).count({ where: { userId } }),
    );
    if (count === 0) {
      await this.recalculateAllAccounts(userId);
      return;
    }

    await this.refreshStaleAccountsForCurrentMonth(userId);
  }

  /**
   * Per-account recalc is debounced and only runs when an account's
   * transactions change. When the calendar rolls into a new month, accounts
   * that haven't been touched still have snapshots ending in the previous
   * month, so they don't contribute to the new month's aggregate -- causing
   * the chart to drop to whatever subset of accounts had a transaction post
   * since the month rolled over. Detect those stale accounts and refresh them.
   */
  private async refreshStaleAccountsForCurrentMonth(
    userId: string,
  ): Promise<void> {
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}-01`;

    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId },
        select: ["id"],
      }),
    );
    if (accounts.length === 0) return;

    const populated = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonthlyAccountBalance).find({
        where: { userId, month: currentMonthStr },
        select: ["accountId"],
      }),
    );
    const populatedIds = new Set(populated.map((p) => p.accountId));

    const staleIds = accounts
      .map((a) => a.id)
      .filter((id) => !populatedIds.has(id));
    if (staleIds.length === 0) return;

    await Promise.all(
      staleIds.map((id) =>
        this.recalculateAccount(userId, id).catch((err) =>
          this.logger.warn(
            `Failed to refresh stale net worth for account ${id}: ${err.message}`,
          ),
        ),
      ),
    );
  }

  /**
   * Joint accounts' snapshots are owner-maintained, so ensurePopulated
   * (keyed to the caller) never refreshes them: when the calendar rolls into
   * a new month before the owner's next recalc, the grantee's chart would
   * silently drop the joint account from the current month. Refresh each
   * stale joint account under ITS OWNER's context -- identity-correct writes
   * (mab rows carry the owner's user_id) that both users then see.
   */
  private async refreshStaleJointMonths(
    scope: JointNetWorthScope,
  ): Promise<void> {
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}-01`;

    const ids = scope.accounts.map((a) => a.accountId);
    // Readable in the grantee's session (migration-134 arm at enforcement).
    const populated = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonthlyAccountBalance).find({
        where: { accountId: In(ids), month: currentMonthStr },
        select: ["accountId"],
      }),
    );
    const populatedIds = new Set(populated.map((p) => p.accountId));

    const stale = scope.accounts.filter((a) => !populatedIds.has(a.accountId));
    await Promise.all(
      stale.map(({ accountId, ownerUserId }) =>
        withUserContext(ownerUserId, () =>
          this.recalculateAccount(ownerUserId, accountId),
        ).catch((err) =>
          this.logger.warn(
            `Failed to refresh stale joint net worth for account ${accountId}: ${err.message}`,
          ),
        ),
      ),
    );
  }

  /**
   * Check if an account is a brokerage or standalone investment account
   * (i.e. an account that can hold securities and needs market value tracking)
   */
  private isBrokerageOrStandaloneInvestment(account: Account): boolean {
    return (
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
      (account.accountType === AccountType.INVESTMENT &&
        !account.accountSubType)
    );
  }

  /**
   * Recalculate monthly snapshots for all investment accounts that have holdings.
   * Called after security prices are refreshed to keep chart data in sync.
   */
  async recalculateAllInvestmentSnapshots(): Promise<void> {
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Account)
        .createQueryBuilder("a")
        .where("a.accountType = :type", { type: AccountType.INVESTMENT })
        .andWhere(
          "(a.accountSubType = :brokerage OR a.accountSubType IS NULL)",
          { brokerage: AccountSubType.INVESTMENT_BROKERAGE },
        )
        .getMany(),
    );

    await Promise.all(
      accounts.map(async (account) => {
        try {
          await this.recalculateBrokerageAccount(account.userId, account);
        } catch (err) {
          this.logger.warn(
            `Failed to recalculate investment snapshot for account ${account.id}: ${err.message}`,
          );
        }
      }),
    );
  }

  /**
   * Monthly net worth history shaped for LLM tools. Shared by the AI
   * Assistant and MCP `generate_report` tools (type `net_worth_history`) so
   * both surfaces return the same data with the same default range (last 12
   * months if no dates provided).
   */
  async getLlmHistory(
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<
    {
      month: string;
      assets: number;
      liabilities: number;
      netWorth: number;
      /**
       * False when a component of this month could not be converted into the
       * reporting currency, which makes the three figures above subtotals of
       * what did convert. A missing rate used to be applied as 1:1 (audit
       * P5-009); see docs/specs/fx-conversion-completeness.md.
       */
      fxComplete: boolean;
      /** `"JPY->USD"` for each pair with no available rate. */
      missingRatePairs: string[];
    }[]
  > {
    const today = new Date();
    const defaultStart = new Date(today.getFullYear() - 1, today.getMonth(), 1)
      .toISOString()
      .substring(0, 10);
    const resolvedStart = startDate || defaultStart;
    const resolvedEnd = endDate || today.toISOString().substring(0, 10);
    // `fetchMissing: false`: a tool call is not a user waiting on a chart. The
    // model gets what the database holds, with the same completeness flags and
    // the same named pairs it would get for any other gap, and no HTTP request
    // to a provider is made on an LLM's behalf.
    const months = await this.getMonthlyNetWorth(
      userId,
      resolvedStart,
      resolvedEnd,
      undefined,
      {
        fetchMissing: false,
      },
    );
    // The per-account-type split is drawing data for the chart, and the
    // per-side completeness flags are for the dashboard's own readers; the
    // tools' shape stays the three figures and their completeness.
    return months.map(
      ({
        byAccountType: _byAccountType,
        assetsFxComplete: _assetsFxComplete,
        liabilitiesFxComplete: _liabilitiesFxComplete,
        ...month
      }) => month,
    );
  }

  async getMonthlyNetWorth(
    userId: string,
    startDate?: string,
    endDate?: string,
    jointScope?: JointNetWorthScope,
    options?: SeriesFetchOptions,
  ): Promise<
    {
      month: string;
      assets: number;
      liabilities: number;
      netWorth: number;
      /**
       * False when a component of this month could not be converted into the
       * reporting currency, which makes the three figures above subtotals of
       * what did convert. A missing rate used to be applied as 1:1 (audit
       * P5-009); see docs/specs/fx-conversion-completeness.md.
       */
      fxComplete: boolean;
      /** `"JPY->USD"` for each pair with no available rate. */
      missingRatePairs: string[];
      /**
       * Which side of the month is short of a rate: `assets` and `liabilities`
       * above are each a total only while their own flag is true, and a reader
       * of one must not be told the other side's gap makes it a subtotal.
       */
      assetsFxComplete: boolean;
      liabilitiesFxComplete: boolean;
      /**
       * What each account type contributes to `netWorth`: an asset type's
       * value, a liability type's owed amount negated, so the entries sum to
       * `netWorth` (to rounding). Only the types the month holds appear.
       * Subtotals of what converted under the same `fxComplete` as the rest.
       */
      byAccountType: Partial<Record<AccountType, number>>;
    }[]
  > {
    await this.ensurePopulated(userId);
    const jointIds = jointScope?.accounts.map((a) => a.accountId) ?? [];
    if (jointScope && jointIds.length > 0) {
      await this.refreshStaleJointMonths(jointScope);
    }

    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = preferredCurrency(pref);

    const start = startDate || "1990-01-01";
    const end = endDate || new Date().toISOString().slice(0, 10);

    // Own rows keep the owner-side exclude_from_net_worth predicate; joint
    // rows are governed solely by the pre-filtered scope (see
    // JointNetWorthScope). One predicate for the series and (via
    // getLatestNetWorth) the latest month, so the two can never disagree.
    const snapshots = await this.scopedQuery<MonthlySnapshotRow>(
      `SELECT mab.month, mab.balance, mab.market_value,
              a.id as account_id, a.account_type, a.account_sub_type, a.currency_code
       FROM monthly_account_balances mab
       JOIN accounts a ON a.id = mab.account_id
       WHERE ((mab.user_id = $1 AND a.exclude_from_net_worth = false)
              OR mab.account_id = ANY($4::UUID[]))
         AND mab.month >= DATE_TRUNC('month', $2::DATE)
         AND mab.month <= DATE_TRUNC('month', $3::DATE)
       ORDER BY mab.month`,
      [userId, start, end, jointIds],
    );

    if (snapshots.length === 0) return [];

    // Collect currencies that need conversion
    const currencies = new Set<string>();
    for (const s of snapshots) {
      if (s.currency_code !== defaultCurrency) {
        currencies.add(s.currency_code);
      }
    }

    return this.computeWithRateFill(
      async () =>
        this.foldMonthlyNetWorth(
          snapshots,
          defaultCurrency,
          await this.buildRateIndex(currencies, defaultCurrency, start, end),
        ),
      // A monthly point's `month` is its month-first date, which is the month
      // the fill fetches; the conversion happens at that month's end.
      (months) =>
        months.map((m) => ({
          date: m.month,
          missingRatePairs: m.missingRatePairs,
        })),
      options,
    );
  }

  /** The month-by-month fold of `getMonthlyNetWorth`, at one rate index. */
  private foldMonthlyNetWorth(
    snapshots: MonthlySnapshotRow[],
    defaultCurrency: string,
    rateIndex: RateIndex,
  ): {
    month: string;
    assets: number;
    liabilities: number;
    netWorth: number;
    fxComplete: boolean;
    missingRatePairs: string[];
    assetsFxComplete: boolean;
    liabilitiesFxComplete: boolean;
    byAccountType: Partial<Record<AccountType, number>>;
  }[] {
    // Aggregate by month. Assets and liabilities each accumulate through an
    // FxAggregate so a month containing a component with no available rate
    // reports an unknown total instead of a plausible wrong one (P5-009).
    // Each account type's signed contribution accumulates the same way.
    const monthMap = new Map<
      string,
      {
        assets: FxAggregate;
        liabilities: FxAggregate;
        byAccountType: Map<AccountType, FxAggregate>;
      }
    >();

    for (const s of snapshots) {
      const monthKey = this.toDateString(s.month);

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, {
          assets: new FxAggregate(),
          liabilities: new FxAggregate(),
          byAccountType: new Map(),
        });
      }
      const entry = monthMap.get(monthKey)!;

      // For brokerage accounts: use market_value (holdings only; cash is in linked account)
      // For standalone investment accounts: use market_value + balance (holdings + cash)
      // For all others: use balance
      let rawValue: number;
      if (
        s.account_sub_type === "INVESTMENT_BROKERAGE" &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value);
      } else if (
        s.account_type === "INVESTMENT" &&
        s.account_sub_type === null &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value) + Number(s.balance);
      } else {
        rawValue = Number(s.balance);
      }

      // Compute month-end date for rate lookup
      const monthEnd = this.monthEndDate(monthKey);
      const converted = this.convertCurrency(
        rawValue,
        s.currency_code,
        defaultCurrency,
        monthEnd,
        rateIndex,
      );

      const accountType = s.account_type as AccountType;
      if (!entry.byAccountType.has(accountType)) {
        entry.byAccountType.set(accountType, new FxAggregate());
      }
      const typeTotal = entry.byAccountType.get(accountType)!;
      if (LIABILITY_TYPES.includes(accountType)) {
        const owed = converted === null ? null : Math.abs(converted);
        entry.liabilities.add(owed, s.currency_code, defaultCurrency);
        typeTotal.add(
          owed === null ? null : -owed,
          s.currency_code,
          defaultCurrency,
        );
      } else {
        entry.assets.add(converted, s.currency_code, defaultCurrency);
        typeTotal.add(converted, s.currency_code, defaultCurrency);
      }
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => {
        // Per docs/financial-calculation-contract.md section 1: the total is
        // null unless every component converted, the partial sum travels in a
        // separately named field, and the response says what is missing.
        const missingRatePairs = [
          ...new Set([
            ...data.assets.missingPairs,
            ...data.liabilities.missingPairs,
          ]),
        ].sort();
        return {
          month,
          assets: Math.round(data.assets.knownSubtotal),
          liabilities: Math.round(data.liabilities.knownSubtotal),
          netWorth: Math.round(
            data.assets.knownSubtotal - data.liabilities.knownSubtotal,
          ),
          // Stage 1 of docs/specs/fx-conversion-completeness.md: the three
          // figures above are the subtotal of what converted, and these two
          // fields say so. They are NOT yet nullable -- that is stage 2, with
          // the frontend and copy work it needs -- but a consumer can now tell
          // a complete total from a partial one, which it could not when a
          // missing rate silently became 1:1.
          fxComplete: missingRatePairs.length === 0,
          missingRatePairs,
          assetsFxComplete: data.assets.missingPairs.length === 0,
          liabilitiesFxComplete: data.liabilities.missingPairs.length === 0,
          byAccountType: Object.fromEntries(
            [...data.byAccountType].map(([type, total]) => [
              type,
              Math.round(total.knownSubtotal),
            ]),
          ),
        };
      });
  }

  /**
   * Latest-month net worth only. The account summary and the
   * `get_account_balances` tool need just the most recent month's
   * assets/liabilities/netWorth, not the whole series. Bounding the snapshot
   * query and rate index to a single month avoids replaying the entire
   * monthly_account_balances history just to read the last element. Returns
   * null when the user has no populated snapshots.
   *
   * `assets`, `liabilities` and `netWorth` are SUBTOTALS of what converted into
   * the reporting currency, exactly as in `getMonthlyNetWorth`: the flags beside
   * them say whether they are totals. A caller that presents one as a total
   * reads `fxComplete` (everything converted), `assetsFxComplete` and
   * `liabilitiesFxComplete` (which side is short), and names
   * `missingRatePairs`. The snapshot stores one figure per account and month, so
   * a gap between a security's currency and its account's, or a position with no
   * price, is invisible here; `AccountsService` unions those in from
   * `PortfolioService.getAccountMarketValues`.
   */
  async getLatestNetWorth(
    userId: string,
    jointScope?: JointNetWorthScope,
  ): Promise<{
    assets: number;
    liabilities: number;
    netWorth: number;
    fxComplete: boolean;
    missingRatePairs: string[];
    assetsFxComplete: boolean;
    liabilitiesFxComplete: boolean;
  } | null> {
    await this.ensurePopulated(userId);

    const jointIds = jointScope?.accounts.map((a) => a.accountId) ?? [];
    const latestRows: { month: string | Date }[] = await this.scopedQuery(
      `SELECT MAX(month) AS month FROM monthly_account_balances
        WHERE user_id = $1 OR account_id = ANY($2::UUID[])`,
      [userId, jointIds],
    );
    const latestMonth = latestRows[0]?.month;
    if (!latestMonth) return null;

    const monthStr = this.toDateString(latestMonth);
    const months = await this.getMonthlyNetWorth(
      userId,
      monthStr,
      monthStr,
      jointScope,
    );
    const latest = months[months.length - 1];
    if (!latest) return null;
    return {
      assets: latest.assets,
      liabilities: latest.liabilities,
      netWorth: latest.netWorth,
      fxComplete: latest.fxComplete,
      missingRatePairs: latest.missingRatePairs,
      assetsFxComplete: latest.assetsFxComplete,
      liabilitiesFxComplete: latest.liabilitiesFxComplete,
    };
  }

  async getMonthlyInvestments(
    userId: string,
    startDate?: string,
    endDate?: string,
    accountIds?: string[],
    displayCurrency?: string,
    options?: SeriesFetchOptions,
  ): Promise<
    {
      month: string;
      value: number;
      /** False when a component could not be converted; see missingRatePairs. */
      fxComplete: boolean;
      /** `"USD->EUR"` for each pair with no available rate. */
      missingRatePairs: string[];
    }[]
  > {
    await this.ensurePopulated(userId);

    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = displayCurrency || preferredCurrency(pref);

    const start = startDate || "1990-01-01";
    const end = endDate || new Date().toISOString().slice(0, 10);

    let accountFilter: string;
    const params: unknown[] = [userId, start, end];

    if (accountIds && accountIds.length > 0) {
      // The brokerage and its cash sleeve are one portfolio; the widening rule
      // is `resolveInvestmentScopeAccountIds`, shared with every other surface
      // that takes this filter.
      const idArray = await resolveInvestmentScopeAccountIds(
        (sql, params) => this.scopedQuery(sql, params),
        userId,
        accountIds,
      );
      if (idArray.length === 0) {
        // No matching accounts found — return empty result
        return [];
      }
      // Build parameterized IN clause
      const placeholders = idArray.map((_, i) => `$${i + 4}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      params.push(...idArray);
    } else {
      accountFilter = `AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`;
    }

    const snapshots = await this.scopedQuery<MonthlySnapshotRow>(
      `SELECT mab.month, mab.balance, mab.market_value,
              a.id as account_id, a.account_type, a.account_sub_type, a.currency_code
       FROM monthly_account_balances mab
       JOIN accounts a ON a.id = mab.account_id
       WHERE mab.user_id = $1
         AND mab.month >= DATE_TRUNC('month', $2::DATE)
         AND mab.month <= DATE_TRUNC('month', $3::DATE)
         ${accountFilter}
       ORDER BY mab.month`,
      params,
    );

    if (snapshots.length === 0) return [];

    const currencies = new Set<string>();
    for (const s of snapshots) {
      if (s.currency_code !== defaultCurrency) {
        currencies.add(s.currency_code);
      }
    }

    return this.computeWithRateFill(
      () =>
        this.foldMonthlyInvestments(
          userId,
          snapshots,
          defaultCurrency,
          currencies,
          start,
          end,
        ),
      (months) =>
        months.map((m) => ({
          date: m.month,
          missingRatePairs: m.missingRatePairs,
        })),
      options,
    );
  }

  /**
   * The month-by-month fold of `getMonthlyInvestments`, at one rate index.
   *
   * The first-month cost basis is recomputed here rather than hoisted out
   * because it converts too: after a fill stored the rates it was short of, its
   * own gaps have to close with everyone else's.
   */
  private async foldMonthlyInvestments(
    userId: string,
    snapshots: MonthlySnapshotRow[],
    defaultCurrency: string,
    currencies: Set<string>,
    start: string,
    end: string,
  ): Promise<
    {
      month: string;
      value: number;
      securitiesValue: number;
      fxComplete: boolean;
      missingRatePairs: string[];
    }[]
  > {
    // For the first active month of an account, the stored market_value is the
    // month-end snapshot which silently absorbs any gains/losses on positions
    // that were established earlier the same month -- skewing the chart's
    // change column. Replace that first-month market_value with a cost-basis
    // computed from the in-month brokerage transactions so the starting point
    // reflects the actual net invested.
    const firstMonthCostBasisInDefault =
      await this.computeFirstActiveMonthCostBasis(
        userId,
        snapshots,
        defaultCurrency,
        start,
        end,
      );

    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    const monthMap = new Map<string, FxAggregate>();
    // The invested part of the same month, folded beside the whole value: the
    // securities without the cash sleeves and without a standalone account's
    // own cash balance. One walk, two aggregates, so the two cannot disagree
    // about a position (`docs/specs/portfolio-period-result.md` section 10.7).
    const securitiesMap = new Map<string, FxAggregate>();

    for (const s of snapshots) {
      const monthKey = this.toDateString(s.month);

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, new FxAggregate());
        securitiesMap.set(monthKey, new FxAggregate());
      }

      const monthEnd = this.monthEndDate(monthKey);
      const adjKey = `${s.account_id}:${monthKey}`;
      const costBasisInDefault = firstMonthCostBasisInDefault.get(adjKey);

      const monthAggregate = monthMap.get(monthKey)!;
      const securitiesAggregate = securitiesMap.get(monthKey)!;
      if (costBasisInDefault !== undefined) {
        // The seed IS the securities: it is the cost basis of the month's
        // brokerage transactions, with the standalone account's cash added
        // beside it below.
        securitiesAggregate.merge(costBasisInDefault);
        // merge, not addConverted: the seed's gaps travel with its subtotal,
        // so an unconvertible first-month component marks the month incomplete.
        monthAggregate.merge(costBasisInDefault);
        // Standalone investment accounts hold cash inside the same account, so
        // include the month-end cash balance alongside the cost basis.
        if (s.account_type === "INVESTMENT" && s.account_sub_type === null) {
          monthAggregate.add(
            this.convertCurrency(
              Number(s.balance),
              s.currency_code,
              defaultCurrency,
              monthEnd,
              rateIndex,
            ),
            s.currency_code,
            defaultCurrency,
          );
        }
      } else {
        let rawValue: number;
        // What of that value is invested: a brokerage's market value, a
        // standalone account's market value without its own cash, and nothing
        // at all from a cash sleeve.
        let investedValue: number;
        if (
          s.account_sub_type === "INVESTMENT_BROKERAGE" &&
          s.market_value != null
        ) {
          rawValue = Number(s.market_value);
          investedValue = rawValue;
        } else if (
          s.account_type === "INVESTMENT" &&
          s.account_sub_type === null &&
          s.market_value != null
        ) {
          rawValue = Number(s.market_value) + Number(s.balance);
          investedValue = Number(s.market_value);
        } else {
          rawValue = Number(s.balance);
          investedValue = 0;
        }

        monthAggregate.add(
          this.convertCurrency(
            rawValue,
            s.currency_code,
            defaultCurrency,
            monthEnd,
            rateIndex,
          ),
          s.currency_code,
          defaultCurrency,
        );
        if (investedValue !== 0) {
          securitiesAggregate.add(
            this.convertCurrency(
              investedValue,
              s.currency_code,
              defaultCurrency,
              monthEnd,
              rateIndex,
            ),
            s.currency_code,
            defaultCurrency,
          );
        }
      }
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, aggregate]) => ({
        month,
        // 4dp money precision, not whole units: the value carries into the
        // period-result P&L and TWR, so the grosze must survive the fold and be
        // rounded only for display at the surface.
        value: roundMoney(aggregate.knownSubtotal),
        securitiesValue: roundMoney(
          securitiesMap.get(month)?.knownSubtotal ?? 0,
        ),
        fxComplete: aggregate.isComplete,
        missingRatePairs: aggregate.missingPairs,
      }));
  }

  /**
   * For each brokerage / standalone-investment account in `snapshots` whose
   * snapshot row coincides with that account's first-ever active month,
   * compute the net cost basis of all in-month investment transactions
   * converted to `defaultCurrency`. Returns a map keyed by
   * `${accountId}:${monthKey}` -> an `FxAggregate` carrying the converted
   * value *and* any conversion gaps, so a component the seed could not convert
   * marks the month incomplete instead of being dropped into a partial sum
   * that ships under `fxComplete: true`.
   */
  private async computeFirstActiveMonthCostBasis(
    userId: string,
    snapshots: MonthlySnapshotRow[],
    defaultCurrency: string,
    start: string,
    end: string,
  ): Promise<Map<string, FxAggregate>> {
    const result = new Map<string, FxAggregate>();

    const eligibleSnapshots = snapshots.filter((s) => {
      const isBrokerage = s.account_sub_type === "INVESTMENT_BROKERAGE";
      const isStandalone =
        s.account_type === "INVESTMENT" && s.account_sub_type === null;
      return isBrokerage || isStandalone;
    });
    if (eligibleSnapshots.length === 0) return result;

    const accountIds = [...new Set(eligibleSnapshots.map((s) => s.account_id))];

    const firstMonthRows = await this.scopedQuery<FirstMonthRow>(
      `SELECT account_id, MIN(month)::DATE as first_month
       FROM monthly_account_balances
       WHERE account_id = ANY($1::UUID[]) AND user_id = $2
       GROUP BY account_id`,
      [accountIds, userId],
    );
    const firstActiveMonth = new Map<string, string>();
    for (const r of firstMonthRows) {
      firstActiveMonth.set(r.account_id, this.toDateString(r.first_month));
    }

    const targetMonthByAccount = new Map<string, string>();
    for (const s of eligibleSnapshots) {
      const monthKey = this.toDateString(s.month);
      if (firstActiveMonth.get(s.account_id) === monthKey) {
        targetMonthByAccount.set(s.account_id, monthKey);
      }
    }
    if (targetMonthByAccount.size === 0) return result;

    const targetAccountIds = [...targetMonthByAccount.keys()];
    const txRows = await this.scopedQuery<FirstMonthTradeRow>(
      `SELECT it.account_id, it.action, it.quantity, it.price, it.commission,
              it.total_amount, it.transaction_date,
              s.currency_code AS security_currency
       FROM investment_transactions it
       LEFT JOIN securities s ON s.id = it.security_id
       WHERE it.account_id = ANY($1::UUID[])
         AND it.status != 'VOID'
         AND (it.action = ANY($2) OR it.action IN ('TRANSFER_IN', 'TRANSFER_OUT'))`,
      [targetAccountIds, MARKET_PRICED_TRADE_ACTIONS],
    );

    const adjCurrencies = new Set<string>();
    for (const r of txRows) {
      if (r.security_currency && r.security_currency !== defaultCurrency) {
        adjCurrencies.add(r.security_currency);
      }
    }
    const rateIndex =
      adjCurrencies.size > 0
        ? await this.buildRateIndex(adjCurrencies, defaultCurrency, start, end)
        : new Map();

    for (const r of txRows) {
      const targetMonth = targetMonthByAccount.get(r.account_id);
      if (!targetMonth) continue;
      const txDate = this.toDateString(r.transaction_date);
      if (txDate.substring(0, 7) !== targetMonth.substring(0, 7)) continue;

      const qty = Number(r.quantity) || 0;
      if (qty === 0) continue;

      const action = baseInvestmentAction(r.action);
      const isOut = action === "SELL" || action === "TRANSFER_OUT";
      if (
        !isOut &&
        action !== "BUY" &&
        action !== "REINVEST" &&
        action !== "TRANSFER_IN"
      ) {
        continue;
      }

      // The row's executed total (commission included on an acquisition),
      // never `quantity * price` beside it. A sale's stored total is already
      // net of its commission, so none is added. A row that cannot state a
      // cost is an unknown component of the month, not a dropped one.
      const cost = acquisitionCost({
        quantity: qty,
        price: r.price,
        commission: isOut ? 0 : r.commission,
        totalAmount: r.total_amount,
      });
      const signed = cost === null ? null : isOut ? -cost : cost;

      const secCurrency = r.security_currency || defaultCurrency;
      const monthEnd = this.monthEndDate(targetMonth);
      const inDefault =
        signed === null
          ? null
          : this.convertCurrency(
              signed,
              secCurrency,
              defaultCurrency,
              monthEnd,
              rateIndex,
            );

      // A cost-basis component with no rate is recorded as a gap on the
      // month's aggregate rather than added at 1:1 -- or silently dropped: a
      // seed that skipped it left the month's value understated while the
      // response still said `fxComplete: true`, the exact "flag that does not
      // cover every total" shape the completeness contract forbids.
      const key = `${r.account_id}:${targetMonth}`;
      let aggregate = result.get(key);
      if (!aggregate) {
        aggregate = new FxAggregate();
        result.set(key, aggregate);
      }
      if (signed === null) aggregate.addUnknown();
      else aggregate.add(inDefault, secCurrency, defaultCurrency);
    }

    return result;
  }

  /**
   * The newest day on or before each boundary on which any security the scope
   * held by then actually has a close -- the trading session a boundary's value
   * came from, as opposed to the calendar day it is dated.
   *
   * `getDailyInvestments` values EVERY calendar day at the latest close at or
   * before it, so a Sunday boundary carries Friday's close and a reader told
   * the figure is measured "from Sunday" is being told the wrong day. Only
   * `security_prices` knows which days a price was struck.
   *
   * Several boundaries in one round trip because the batch route asks for one
   * per preset, and the two routes must answer the same question the same way.
   * A boundary with nothing priced on or before it maps to **null**: the
   * session is unknown, never substituted with the calendar day.
   */
  async getLastPricedDays(
    userId: string,
    boundaries: readonly string[],
    accountIds?: string[],
  ): Promise<Map<string, string | null>> {
    const unique = [...new Set(boundaries)];
    const result = new Map<string, string | null>(
      unique.map((day) => [day, null]),
    );
    if (unique.length === 0) return result;

    const params: unknown[] = [userId, unique];
    let accountFilter = "";
    if (accountIds && accountIds.length > 0) {
      const placeholders = accountIds.map((_, i) => `$${i + 3}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      params.push(...accountIds);
    }

    const rows: Array<{ boundary: string; date: string | null }> =
      await this.scopedQuery(
        `SELECT TO_CHAR(b.day, 'YYYY-MM-DD') AS boundary, p.date
           FROM UNNEST($2::DATE[]) AS b(day)
           LEFT JOIN LATERAL (
             SELECT MAX(sp.price_date)::TEXT AS date
               FROM security_prices sp
              WHERE sp.price_date <= b.day
                AND sp.security_id IN (
                      SELECT DISTINCT it.security_id
                        FROM investment_transactions it
                        JOIN accounts a ON a.id = it.account_id
                       WHERE a.user_id = $1
                         AND it.security_id IS NOT NULL
                         AND it.status != 'VOID'
                         AND it.transaction_date <= b.day
                         ${accountFilter}
                    )
           ) p ON TRUE`,
        params,
      );
    for (const row of rows) result.set(row.boundary, row.date ?? null);
    return result;
  }

  async getDailyInvestments(
    userId: string,
    startDate?: string,
    endDate?: string,
    accountIds?: string[],
    displayCurrency?: string,
    options?: SeriesFetchOptions,
  ): Promise<DailyInvestmentValue[]> {
    const { series } = await this.loadDailyInvestments(
      userId,
      { startDate, endDate, accountIds, displayCurrency, options },
      false,
    );
    return series;
  }

  /**
   * The daily series sampled for a long-range chart: the window's first day,
   * each month-end strictly inside it, and its last day
   * (`monthEndSampleDates`).
   *
   * Every point is a day of the SAME fold `getDailyInvestments` runs -- the same
   * replay, the same accepted close, the same rate index and the same
   * completeness flags -- so the first point is the close the period result is
   * measured from (`investedValueStart`) and the last is the one it is measured
   * to. The stored month-end snapshots `getMonthlyInvestments` reads open on a
   * month boundary instead, which is a different day from the one the figures
   * under the chart are measured from (`docs/specs/portfolio-period-result.md`
   * section 10.9).
   *
   * "All time" (no `startDate`) opens where the period result's `all` window
   * does: the day before the scope's first investment transaction.
   */
  async getSampledInvestments(
    userId: string,
    opts: {
      startDate?: string;
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
    } & SeriesFetchOptions,
  ): Promise<DailyInvestmentValue[]> {
    const end = opts.endDate || todayYMD();
    let startDate = opts.startDate;
    if (!startDate) {
      const scope = await this.resolveScopedInvestmentAccounts(
        userId,
        opts.accountIds,
      );
      if (scope.length === 0) return [];
      startDate = await this.sampledInceptionStart(
        userId,
        scope.map((a) => a.id),
        end,
      );
    }
    const { series } = await this.loadDailyInvestments(
      userId,
      {
        startDate,
        endDate: end,
        accountIds: opts.accountIds,
        displayCurrency: opts.displayCurrency,
        options: { fetchMissing: opts.fetchMissing },
      },
      false,
    );
    if (series.length === 0) return series;
    const keep = new Set(
      monthEndSampleDates(series[0].date, series[series.length - 1].date),
    );
    return series.filter((point) => keep.has(point.date));
  }

  /**
   * `getDailyInvestments` together with what each of its days was folded
   * from: the share count per security, the accepted close each was valued
   * at, and the cash per currency. One fold answers both, so the intraday
   * chart cannot hold a different position on a past day than the daily series
   * does (`docs/specs/intraday-historical-positions.md`, INV-INTRADAY-001).
   */
  async getDailyInvestmentPositions(
    userId: string,
    opts: {
      startDate: string;
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
    } & SeriesFetchOptions,
  ): Promise<DailyInvestmentsWithPositions> {
    const { fetchMissing, ...window } = opts;
    return this.loadDailyInvestments(
      userId,
      { ...window, options: { fetchMissing } },
      true,
    );
  }

  private async loadDailyInvestments(
    userId: string,
    {
      startDate,
      endDate,
      accountIds,
      displayCurrency,
      options,
    }: {
      startDate?: string;
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
      options?: SeriesFetchOptions;
    },
    collectPositions: boolean,
  ): Promise<DailyInvestmentsWithPositions> {
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = displayCurrency || preferredCurrency(pref);

    // "Today" is the request's calendar day, not a UTC slice of the clock:
    // `todayYMD()` reads the request timezone where one is set.
    const end = endDate || todayYMD();

    // Resolved before keying, so a caller that named the reporting currency
    // and one that left it to the preference share one valuation (#1888).
    return dailyInvestmentsInFlight.run(
      userId,
      buildDailyInvestmentsKey({
        userId,
        startDate,
        endDate: end,
        accountIds,
        currency: defaultCurrency,
        collectPositions,
        fetchMissing: options?.fetchMissing,
      }),
      () =>
        this.computeDailyInvestments(
          userId,
          { startDate, end, accountIds, defaultCurrency, options },
          collectPositions,
        ),
    );
  }

  /** The valuation `loadDailyInvestments` shares, over resolved inputs. */
  private async computeDailyInvestments(
    userId: string,
    {
      startDate,
      end,
      accountIds,
      defaultCurrency,
      options,
    }: {
      startDate?: string;
      end: string;
      accountIds?: string[];
      defaultCurrency: string;
      options?: SeriesFetchOptions;
    },
    collectPositions: boolean,
  ): Promise<DailyInvestmentsWithPositions> {
    const empty: DailyInvestmentsWithPositions = {
      series: [],
      positions: [],
      securities: new Map(),
    };

    let accountFilter: string;
    const acctParams: unknown[] = [userId];

    if (accountIds && accountIds.length > 0) {
      // The brokerage and its cash sleeve are one portfolio; see
      // `resolveInvestmentScopeAccountIds`.
      const idArray = await resolveInvestmentScopeAccountIds(
        (sql, params) => this.scopedQuery(sql, params),
        userId,
        accountIds,
      );
      if (idArray.length === 0) return empty;
      const placeholders = idArray.map((_, i) => `$${i + 2}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      acctParams.push(...idArray);
    } else {
      accountFilter = `AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`;
    }

    // Get investment accounts in scope
    const investAccounts = await this.scopedQuery<ScopedInvestmentAccountRow>(
      `SELECT a.id, a.account_type, a.account_sub_type, a.currency_code, a.opening_balance
       FROM accounts a
       WHERE a.user_id = $1 ${accountFilter}`,
      acctParams,
    );

    if (investAccounts.length === 0) return empty;

    // "All time" (no startDate) begins where the scope's own history begins.
    const start =
      startDate ||
      (await this.resolveInvestmentInception(
        investAccounts.map((a) => a.id),
        end,
      ));

    const brokerageIds = investAccounts
      .filter(
        (a) =>
          a.account_sub_type === "INVESTMENT_BROKERAGE" ||
          (a.account_type === "INVESTMENT" && !a.account_sub_type),
      )
      .map((a) => a.id);
    const cashIds = investAccounts
      .filter((a) => isValuationCashAccount(a))
      .map((a) => a.id);
    // Load investment transactions up to end date for holdings replay
    const invTxs: ReplayTransactionRow[] =
      brokerageIds.length > 0
        ? await this.scopedQuery<ReplayTransactionRow>(
            `SELECT account_id, security_id, action, quantity, transaction_date
           FROM investment_transactions
           WHERE account_id = ANY($1::UUID[])
             AND transaction_date <= $2
             AND status != 'VOID'
           ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
            [brokerageIds, end],
          )
        : [];

    // Collect security IDs and load prices for the date range
    const securityIds = [
      ...new Set(
        invTxs
          .map((t) => t.security_id)
          .filter((id): id is string => id !== null),
      ),
    ];

    // Load securities for currency (skipPriceUpdates is NOT consulted for
    // valuation -- see loadValuationSeries / positionCloseAsOf, #1242).
    const securities =
      securityIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Accepted stored closes for every held security, merged chronologically
    // with the legacy transaction series (positionCloseAsOf). Every day is
    // valued at the latest accepted close on or before it, so a manual/imported
    // price is honoured exactly as a provider quote is.
    const { stored: pricesBySec, txFallback: txPricesBySec } =
      await this.loadValuationSeries(securityIds, start, end);

    // Daily cash balances for INVESTMENT_CASH and standalone accounts, through
    // the one statement `loadDailyCashBalances` holds: this series and the
    // by-security breakdown ask the same question, and a second spelling of it
    // would be two answers to "what did this account hold that day" (#1389).
    const cashBalances = new Map<string, Map<string, number>>();
    if (cashIds.length > 0) {
      const cashRows = await this.loadDailyCashBalances(cashIds, start, end);
      for (const r of cashRows) {
        if (!cashBalances.has(r.account_id))
          cashBalances.set(r.account_id, new Map());
        cashBalances
          .get(r.account_id)!
          .set(this.toDateString(r.date), Number(r.balance));
      }
    }

    // The calendar days of the window, keyed exactly as the SQL above keys its
    // rows. Iterated as strings: a local-midnight `Date` read back in UTC named
    // every day one early east of Greenwich (#1389).
    const dates = enumerateDaysYMD(start, end);

    // Currency conversion setup: include both account currencies (for cash
    // balances) and security currencies (for holdings market value). Prices in
    // security_prices.close_price are stored in the security's native currency,
    // so market value must be converted from security currency -> default
    // currency, not account currency -> default currency.
    const currencies = new Set<string>();
    for (const a of investAccounts) {
      if (a.currency_code !== defaultCurrency) {
        currencies.add(a.currency_code);
      }
    }
    for (const sec of securities) {
      if (sec.currencyCode && sec.currencyCode !== defaultCurrency) {
        currencies.add(sec.currencyCode);
      }
    }
    // Build account currency map (used for cash balance conversion)
    const acctCurrency = new Map<string, string>();
    for (const a of investAccounts) {
      acctCurrency.set(a.id, a.currency_code);
    }

    const folded = await this.computeWithRateFill(
      async () =>
        this.foldDailyInvestments(
          await this.buildRateIndex(currencies, defaultCurrency, start, end),
          {
            dates,
            invTxs,
            securityMap,
            pricesBySec,
            txPricesBySec,
            cashIds,
            cashBalances,
            acctCurrency,
            defaultCurrency,
            collectPositions,
          },
        ),
      (result) => result.series,
      options,
    );
    return { ...folded, securities: securityMap };
  }

  /** The day-by-day fold of `getDailyInvestments`, at one rate index. */
  private foldDailyInvestments(
    rateIndex: RateIndex,
    input: {
      dates: string[];
      invTxs: ReplayTransactionRow[];
      securityMap: Map<string, Security>;
      pricesBySec: Map<string, PricePoint[]>;
      txPricesBySec: Map<string, PricePoint[]>;
      cashIds: string[];
      cashBalances: Map<string, Map<string, number>>;
      acctCurrency: Map<string, string>;
      defaultCurrency: string;
      /** Also record what each day was folded from; see `DailyPositions`. */
      collectPositions?: boolean;
    },
  ): { series: DailyInvestmentValue[]; positions: DailyPositions[] } {
    const {
      dates,
      invTxs,
      securityMap,
      pricesBySec,
      txPricesBySec,
      cashIds,
      cashBalances,
      acctCurrency,
      defaultCurrency,
      collectPositions = false,
    } = input;

    // Replay holdings per-account day by day and compute market value
    // Key: account_id -> (security_id -> quantity)
    const holdingsByAccount = new Map<string, Map<string, number>>();
    let txIdx = 0;

    const result: DailyInvestmentValue[] = [];
    const positions: DailyPositions[] = [];

    for (const dateStr of dates) {
      // Process investment transactions up to this date
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txDate = this.toDateString(tx.transaction_date);
        if (txDate > dateStr) break;

        const secId = tx.security_id;
        const acctId = tx.account_id;
        const qty = Number(tx.quantity) || 0;

        if (secId) {
          if (!holdingsByAccount.has(acctId))
            holdingsByAccount.set(acctId, new Map());
          const acctHoldings = holdingsByAccount.get(acctId)!;

          acctHoldings.set(
            secId,
            applyActionToQuantity(acctHoldings.get(secId) || 0, tx.action, qty),
          );
        }
        txIdx++;
      }

      // Compute market value per holding and convert from security currency
      // to default currency. Security prices are stored in the security's
      // native currency, so we must convert each holding individually rather
      // than treating the total as being in the account's currency.
      const dayValue = new FxAggregate();
      // Positions the scope held at this close that nothing could price. The
      // walk below skips them, so without this set `value` would be a subtotal
      // with nothing beside it to say so.
      const unpricedSecurityIds = new Set<string>();
      const dayPositions: DailyPositions | null = collectPositions
        ? {
            date: dateStr,
            quantities: new Map(),
            closes: new Map(),
            closeValues: new Map(),
            cashByCurrency: new Map(),
          }
        : null;

      for (const [, acctHoldings] of holdingsByAccount) {
        for (const [secId, qty] of acctHoldings) {
          if (Math.abs(qty) < 0.00000001) continue;

          const security = securityMap.get(secId);

          // Value each point at the latest accepted close on or before that day
          // (end-of-day convention). The chart point at date X therefore
          // represents the portfolio's value as of the close of day X, so the
          // series lines up with the month-end-valued monthly snapshots and the
          // final point reflects the most recent available close rather than
          // lagging a trading day behind it. The accepted store wins over the
          // legacy transaction fallback regardless of skipPriceUpdates (#1242).
          const price = positionCloseAsOf(
            pricesBySec.get(secId),
            txPricesBySec.get(secId),
            dateStr,
          );
          if (dayPositions) {
            dayPositions.quantities.set(
              secId,
              (dayPositions.quantities.get(secId) ?? 0) + qty,
            );
            dayPositions.closes.set(secId, price ?? null);
          }

          if (price != null) {
            const valueInSecCurrency = qty * price;
            const secCurrency = security?.currencyCode || defaultCurrency;
            const converted = this.convertCurrency(
              valueInSecCurrency,
              secCurrency,
              defaultCurrency,
              dateStr,
              rateIndex,
            );
            dayValue.add(converted, secCurrency, defaultCurrency);
            if (dayPositions) {
              const prior = dayPositions.closeValues.get(secId);
              dayPositions.closeValues.set(
                secId,
                converted === null || prior === null
                  ? null
                  : (prior ?? 0) + converted,
              );
            }
          } else {
            // A held position with no accepted close on or before this day. Its
            // market value is UNKNOWN, not zero: skipping it silently is what
            // made `value` a subtotal wearing a total's name. `value` is left
            // as it was (additive change, design 6.2); the flag is what a
            // consumer reads before printing it.
            unpricedSecurityIds.add(secId);
            dayPositions?.closeValues.set(secId, null);
          }
        }
      }

      // Everything above is the invested part; everything below is cash. The
      // aggregate is snapshotted here rather than accumulated twice, so the two
      // figures are one walk over one set of positions.
      const securitiesSubtotal = dayValue.knownSubtotal;

      // Add cash balances for INVESTMENT_CASH and standalone accounts. The walk
      // is over the accounts in scope, not over the maps the query returned: an
      // account with no row for this day is a missing component, and `?? 0`
      // turned exactly that into a real-looking zero balance (#1389).
      const unknownCashAccountIds = new Set<string>();
      for (const acctId of cashIds) {
        const bal = cashBalances.get(acctId)?.get(dateStr);
        if (bal === undefined) {
          unknownCashAccountIds.add(acctId);
          continue;
        }
        const currency = acctCurrency.get(acctId) || defaultCurrency;
        dayValue.add(
          this.convertCurrency(
            bal,
            currency,
            defaultCurrency,
            dateStr,
            rateIndex,
          ),
          currency,
          defaultCurrency,
        );
        dayPositions?.cashByCurrency.set(
          currency,
          (dayPositions.cashByCurrency.get(currency) ?? 0) + bal,
        );
      }
      if (dayPositions) positions.push(dayPositions);

      result.push({
        date: dateStr,
        // Carried at the money pipeline's 4dp precision, never whole units:
        // this value feeds investedPeriodResult's P&L, TWR and MWR, and
        // rounding the grosze away here read a sub-unit holding as a -100%
        // return. Whole-unit rounding is a presentation step at the surface.
        value: roundMoney(dayValue.knownSubtotal),
        // The securities-only subtotal of the very same fold, rounded the same
        // way `value` is, so `value - securitiesValue` is the cash the walk
        // above added and the two cannot disagree about a position.
        securitiesValue: roundMoney(securitiesSubtotal),
        fxComplete: dayValue.isComplete,
        missingRatePairs: dayValue.missingPairs,
        pricesComplete: unpricedSecurityIds.size === 0,
        unpricedSecurityIds: [...unpricedSecurityIds].sort(),
        cashComplete: unknownCashAccountIds.size === 0,
        unknownCashAccountIds: [...unknownCashAccountIds].sort(),
      });
    }

    return { series: result, positions };
  }

  /**
   * Per-security contribution to the portfolio value over time, for the
   * Portfolio Value Over Time report's "by security" view. Replays holdings
   * over the requested window (day-by-day for daily granularity, month-by-month
   * for monthly) and values each security individually, so the returned bands
   * stack up to the total portfolio value. Cash held in investment cash /
   * standalone accounts is returned as its own aggregate band.
   *
   * The `limit` largest securities (ranked by their peak contribution across
   * the window) keep their own band; the rest roll into a single "other" band
   * so a large portfolio stays legible. Read-only; does not touch the stored
   * monthly snapshots that the aggregate views use.
   */
  async getInvestmentBreakdown(
    userId: string,
    opts: {
      granularity: InvestmentBreakdownGranularity;
      startDate?: string;
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
      limit?: number;
    } & SeriesFetchOptions,
  ): Promise<InvestmentBreakdown> {
    const { granularity } = opts;
    const limit = opts.limit ?? 10;

    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = opts.displayCurrency || preferredCurrency(pref);

    const end = opts.endDate || todayYMD();

    const empty: InvestmentBreakdown = {
      granularity,
      currency: defaultCurrency,
      series: [],
      points: [],
      // Nothing to convert is complete, not unknown.
      fxComplete: true,
      missingRatePairs: [],
    };

    const investAccounts = await this.resolveScopedInvestmentAccounts(
      userId,
      opts.accountIds,
    );
    if (investAccounts.length === 0) return empty;

    // "All time" (no startDate) begins where the scope's own history begins;
    // a sampled series opens where the period result's `all` window does.
    const scopeIds = investAccounts.map((a) => a.id);
    const start =
      opts.startDate ||
      (granularity === "monthEnd"
        ? await this.sampledInceptionStart(userId, scopeIds, end)
        : await this.resolveInvestmentInception(scopeIds, end));

    const brokerageIds = investAccounts
      .filter(
        (a) =>
          a.account_sub_type === "INVESTMENT_BROKERAGE" ||
          (a.account_type === "INVESTMENT" && !a.account_sub_type),
      )
      .map((a) => a.id);
    const cashIds = investAccounts
      .filter((a) => isValuationCashAccount(a))
      .map((a) => a.id);

    // Investment transactions from inception up to the window end, so holdings
    // can be replayed forward to each sample point.
    const invTxs: ReplayTransactionRow[] =
      brokerageIds.length > 0
        ? await this.scopedQuery<ReplayTransactionRow>(
            `SELECT account_id, security_id, action, quantity, transaction_date
             FROM investment_transactions
             WHERE account_id = ANY($1::UUID[])
               AND transaction_date <= $2
               AND status != 'VOID'
             ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
            [brokerageIds, end],
          )
        : [];

    const securityIds = [
      ...new Set(
        invTxs
          .map((t) => t.security_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const securities =
      securityIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Build the ordered list of sample dates and, for each, a valuation date
    // (the date whose close values that point) plus a price lookup.
    const sampleDates =
      granularity === "monthly"
        ? this.enumerateMonths(start, end)
        : granularity === "monthEnd"
          ? monthEndSampleDates(start, end)
          : enumerateDaysYMD(start, end);
    if (sampleDates.length === 0) return empty;

    // --- Price lookups -------------------------------------------------------
    // Every point is valued at the latest accepted close on or before its
    // valuation date (the day itself for daily, the month end for monthly),
    // from security_prices merged chronologically with the legacy transaction
    // series. One load for both granularities and no skipPriceUpdates branch --
    // see positionCloseAsOf (#1242).
    // Window the price load to the samples actually valued: monthly points are
    // valued at their month end, which can run past the report `end`, so bound
    // to the last sample's valuation date rather than to `end`.
    const lastSample = sampleDates[sampleDates.length - 1];
    const loadEnd =
      granularity === "monthly" ? this.monthEndDate(lastSample) : lastSample;
    const { stored: storedSeries, txFallback: txSeries } =
      await this.loadValuationSeries(securityIds, sampleDates[0], loadEnd);

    // --- Cash balances -------------------------------------------------------
    const cashBalances = new Map<string, Map<string, number>>();
    if (cashIds.length > 0) {
      const cashRows: Array<{
        account_id: string;
        day: string;
        balance: NumericColumn;
      }> =
        granularity === "monthly"
          ? (await this.loadMonthlyCashBalances(cashIds, start, end)).map(
              (r) => ({ ...r, day: r.month }),
            )
          : (await this.loadDailyCashBalances(cashIds, start, end)).map(
              (r) => ({ ...r, day: r.date }),
            );
      for (const r of cashRows) {
        if (!cashBalances.has(r.account_id))
          cashBalances.set(r.account_id, new Map());
        cashBalances
          .get(r.account_id)!
          .set(this.toDateString(r.day), Number(r.balance));
      }
    }

    // --- Currency conversion -------------------------------------------------
    const currencies = new Set<string>();
    for (const a of investAccounts) {
      if (a.currency_code !== defaultCurrency) currencies.add(a.currency_code);
    }
    for (const sec of securities) {
      if (sec.currencyCode && sec.currencyCode !== defaultCurrency) {
        currencies.add(sec.currencyCode);
      }
    }
    const acctCurrency = new Map<string, string>();
    for (const a of investAccounts) acctCurrency.set(a.id, a.currency_code);

    return this.computeWithRateFill(
      async () =>
        this.foldInvestmentBreakdown(
          await this.buildRateIndex(currencies, defaultCurrency, start, end),
          {
            granularity,
            limit,
            defaultCurrency,
            sampleDates,
            invTxs,
            securityMap,
            storedSeries,
            txSeries,
            cashIds,
            cashBalances,
            acctCurrency,
          },
        ),
      (breakdown) => breakdown.points,
      opts,
    );
  }

  /** The point-by-point fold of `getInvestmentBreakdown`, at one rate index. */
  private foldInvestmentBreakdown(
    rateIndex: RateIndex,
    input: {
      granularity: InvestmentBreakdownGranularity;
      limit: number;
      defaultCurrency: string;
      sampleDates: string[];
      invTxs: ReplayTransactionRow[];
      securityMap: Map<string, Security>;
      storedSeries: Map<string, PricePoint[]>;
      txSeries: Map<string, PricePoint[]>;
      cashIds: string[];
      cashBalances: Map<string, Map<string, number>>;
      acctCurrency: Map<string, string>;
    },
  ): InvestmentBreakdown {
    const {
      granularity,
      limit,
      defaultCurrency,
      sampleDates,
      invTxs,
      securityMap,
      storedSeries,
      txSeries,
      cashIds,
      cashBalances,
      acctCurrency,
    } = input;

    // --- Replay holdings, accumulating per security --------------------------
    const holdings = new Map<string, number>(); // securityId -> quantity
    let txIdx = 0;

    const ungrouped: Array<{
      date: string;
      valuesBySec: Map<string, number>;
      cash: number;
      /** Scoped cash accounts with no balance for this point; see the point. */
      unknownCashAccountIds: string[];
      /** Securities held at this point that nothing could price; see the point. */
      unpricedSecurityIds: string[];
      /** Pairs this point alone could not convert; see the point. */
      missingRatePairs: string[];
    }> = [];

    // Pairs the whole breakdown could not resolve a rate for. Collected across
    // every sample so the response can name them rather than presenting a
    // subtotal as a total (P5-009).
    const missingPairs = new Set<string>();

    for (const sampleDate of sampleDates) {
      const valuationDate =
        granularity === "monthly" ? this.monthEndDate(sampleDate) : sampleDate;

      // Apply every transaction up to this sample point. Daily includes
      // transactions dated on the day itself; monthly includes any transaction
      // whose month is at or before the sample month.
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txDate = this.toDateString(tx.transaction_date);
        if (granularity === "monthly") {
          if (txDate.substring(0, 7) > sampleDate.substring(0, 7)) break;
        } else if (txDate > sampleDate) {
          break;
        }

        const secId = tx.security_id;
        const qty = Number(tx.quantity) || 0;
        if (secId) {
          holdings.set(
            secId,
            applyActionToQuantity(holdings.get(secId) || 0, tx.action, qty),
          );
        }
        txIdx++;
      }

      const valuesBySec = new Map<string, number>();
      // What this point alone is short of, so the reader learns WHICH security
      // and WHICH pair over WHICH dates rather than that "something" was
      // missing somewhere in the range (#1389). The whole-response
      // `missingPairs` below stays as it is: it answers a different question.
      const unpricedSecurityIds = new Set<string>();
      const pointMissingPairs = new Set<string>();
      for (const [secId, qty] of holdings) {
        if (Math.abs(qty) < 0.00000001) continue;
        const security = securityMap.get(secId);
        const price = positionCloseAsOf(
          storedSeries.get(secId),
          txSeries.get(secId),
          valuationDate,
        );
        // Held, but nothing priced it: its band is unknown, not zero, and the
        // point's total is a subtotal of the rest.
        if (price == null) {
          unpricedSecurityIds.add(secId);
          continue;
        }
        const secCurrency = security?.currencyCode || defaultCurrency;
        const value = this.convertCurrency(
          qty * price,
          secCurrency,
          defaultCurrency,
          valuationDate,
          rateIndex,
        );
        // A position with no rate for its pair is left out of the breakdown
        // rather than entered at 1:1, and recorded so the point can say so.
        if (value === null) {
          missingPairs.add(`${secCurrency}->${defaultCurrency}`);
          pointMissingPairs.add(`${secCurrency}->${defaultCurrency}`);
          continue;
        }
        valuesBySec.set(secId, (valuesBySec.get(secId) ?? 0) + value);
      }

      // Cash maps are keyed by the sample date itself: day strings for daily,
      // month-first strings for monthly. The walk is over the accounts IN
      // SCOPE, not over the maps the query returned: an account with no row for
      // a point it was asked for is a missing component, and `?? 0` turned
      // exactly that into a real-looking zero balance (#1389).
      const cashAggregate = new FxAggregate();
      const unknownCashAccountIds = new Set<string>();
      for (const acctId of cashIds) {
        const bal = cashBalances.get(acctId)?.get(sampleDate);
        if (bal === undefined) {
          unknownCashAccountIds.add(acctId);
          continue;
        }
        // Zero needs no rate, and an emptied account is a settled zero.
        if (bal === 0) continue;
        const currency = acctCurrency.get(acctId) || defaultCurrency;
        cashAggregate.add(
          this.convertCurrency(
            bal,
            currency,
            defaultCurrency,
            valuationDate,
            rateIndex,
          ),
          currency,
          defaultCurrency,
        );
      }
      for (const pair of cashAggregate.missingPairs) {
        missingPairs.add(pair);
        pointMissingPairs.add(pair);
      }

      ungrouped.push({
        date: sampleDate,
        valuesBySec,
        cash: cashAggregate.knownSubtotal,
        unknownCashAccountIds: [...unknownCashAccountIds].sort(),
        unpricedSecurityIds: [...unpricedSecurityIds].sort(),
        missingRatePairs: [...pointMissingPairs].sort(),
      });
    }

    const { series, points } = this.groupSecurityBreakdown(
      ungrouped,
      securityMap,
      limit,
    );
    return {
      granularity,
      currency: defaultCurrency,
      series,
      points,
      fxComplete: missingPairs.size === 0,
      missingRatePairs: [...missingPairs].sort(),
    };
  }

  // ---- Private helpers ----

  /**
   * Resolve the investment accounts in scope for a breakdown request, mirroring
   * getDailyInvestments: an explicit id list resolves its linked pairs, an
   * empty list falls back to all of the user's investment cash / brokerage /
   * standalone accounts. Returns the lightweight account rows the replay needs.
   */
  private async resolveScopedInvestmentAccounts(
    userId: string,
    accountIds?: string[],
  ): Promise<ScopedInvestmentAccountRow[]> {
    let accountFilter: string;
    const acctParams: unknown[] = [userId];

    if (accountIds && accountIds.length > 0) {
      const idArray = await resolveInvestmentScopeAccountIds(
        (sql, params) => this.scopedQuery(sql, params),
        userId,
        accountIds,
      );
      if (idArray.length === 0) return [];
      const placeholders = idArray.map((_, i) => `$${i + 2}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      acctParams.push(...idArray);
    } else {
      accountFilter = `AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`;
    }

    return this.scopedQuery<ScopedInvestmentAccountRow>(
      `SELECT a.id, a.account_type, a.account_sub_type, a.currency_code, a.opening_balance
       FROM accounts a
       WHERE a.user_id = $1 ${accountFilter}`,
      acctParams,
    );
  }

  /**
   * Window start for a request that asked for "all time" (no startDate): the
   * earliest date the scoped accounts have anything to show. Per account that
   * is its first non-void transaction or investment transaction, falling back
   * to the date the account was created when it has neither -- the same rule
   * `resolveStartDate` / `recalculateBrokerageAccount` use to decide where an
   * account's monthly snapshots begin, so the by-security chart and the total
   * chart start on the same point rather than years apart.
   *
   * A fixed epoch here is what issue #1081 reported: the per-security series
   * enumerates every sample between start and end, so "all time" prepended
   * three decades of empty months and flattened the real data against the
   * x-axis. Callers resolve their account scope first and return early when it
   * is empty, so this never has to invent a date for an empty scope; the result
   * is clamped to `end` so a reversed window still yields a single point.
   */
  /**
   * Where a sampled "all time" series opens: the day before the scope's first
   * investment transaction, the same day the period result's `all` window is
   * measured from, because that purchase's own close already holds it. A scope
   * with no investment transaction falls back to the general inception rule;
   * the period result has no window to measure there either.
   */
  private async sampledInceptionStart(
    userId: string,
    scopeIds: string[],
    end: string,
  ): Promise<string> {
    const first = await loadFirstInvestmentDate(
      (sql, params) => this.scopedQuery(sql, params),
      userId,
      scopeIds,
    );
    return first
      ? addDaysYMD(first, -1)
      : this.resolveInvestmentInception(scopeIds, end);
  }

  private async resolveInvestmentInception(
    accountIds: string[],
    end: string,
  ): Promise<string> {
    const rows: Array<{ earliest: string | Date | null }> =
      await this.scopedQuery(
        `WITH scoped AS (
            SELECT a.id, a.created_at FROM accounts a WHERE a.id = ANY($1::UUID[])
          ),
          first_tx AS (
            SELECT t.account_id, MIN(t.transaction_date) AS d
              FROM transactions t
             WHERE t.account_id = ANY($1::UUID[])
               AND ${LEDGER_MOVEMENT_PREDICATE}
             GROUP BY t.account_id
          ),
          first_inv AS (
            SELECT it.account_id, MIN(it.transaction_date) AS d
              FROM investment_transactions it
             WHERE it.account_id = ANY($1::UUID[])
               AND it.status != 'VOID'
             GROUP BY it.account_id
          )
          SELECT MIN(
                   COALESCE(LEAST(ft.d, fi.d), s.created_at::DATE)
                 )::TEXT AS earliest
            FROM scoped s
            LEFT JOIN first_tx ft ON ft.account_id = s.id
            LEFT JOIN first_inv fi ON fi.account_id = s.id`,
        [accountIds],
      );

    const earliest = rows?.[0]?.earliest;
    if (!earliest) return end;
    const inception = this.toDateString(earliest);
    return inception > end ? end : inception;
  }

  /** Month-first dates for every month spanned by [start, end], YYYY-MM-01. */
  private enumerateMonths(start: string, end: string): string[] {
    const months: string[] = [];
    const [sy, sm] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, "0")}-01`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return months;
  }

  /** Per-day cash balances for investment cash / standalone accounts. */
  private async loadDailyCashBalances(
    cashIds: string[],
    start: string,
    end: string,
  ): Promise<DailyCashBalanceRow[]> {
    return this.scopedQuery<DailyCashBalanceRow>(
      `WITH target_accounts AS (
          SELECT id, opening_balance
          FROM accounts WHERE id = ANY($1::UUID[])
        ),
        pre_period AS (
          SELECT t.account_id, SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date < $2
          GROUP BY t.account_id
        ),
        daily_tx AS (
          SELECT t.account_id, t.transaction_date::DATE as tx_date, SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date >= $2
            AND t.transaction_date <= $3
          GROUP BY t.account_id, t.transaction_date::DATE
        ),
        account_daily AS (
          SELECT d.dt::DATE as date, ta.id as account_id,
            (ta.opening_balance + COALESCE(pp.total, 0) +
              COALESCE(SUM(dtx.total) OVER (
                PARTITION BY ta.id ORDER BY d.dt ROWS UNBOUNDED PRECEDING
              ), 0)
            ) as balance
          FROM target_accounts ta
          CROSS JOIN generate_series($2::TIMESTAMP, $3::TIMESTAMP, '1 day') d(dt)
          LEFT JOIN pre_period pp ON pp.account_id = ta.id
          LEFT JOIN daily_tx dtx ON dtx.account_id = ta.id AND dtx.tx_date = d.dt::DATE
        )
        SELECT date::TEXT, balance::NUMERIC, account_id FROM account_daily ORDER BY date`,
      [cashIds, start, end],
    );
  }

  /** Per-month-end cash balances for investment cash / standalone accounts. */
  private async loadMonthlyCashBalances(
    cashIds: string[],
    start: string,
    end: string,
  ): Promise<MonthlyCashBalanceRow[]> {
    return this.scopedQuery<MonthlyCashBalanceRow>(
      `WITH target_accounts AS (
          SELECT id, opening_balance FROM accounts WHERE id = ANY($1::UUID[])
        ),
        bounds AS (
          SELECT date_trunc('month', $2::DATE)::DATE AS start_m,
                 date_trunc('month', $3::DATE)::DATE AS end_m
        ),
        pre_period AS (
          SELECT t.account_id, SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          CROSS JOIN bounds b
          WHERE ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date < b.start_m
          GROUP BY t.account_id
        ),
        monthly_tx AS (
          SELECT t.account_id, date_trunc('month', t.transaction_date)::DATE as month,
                 SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          CROSS JOIN bounds b
          WHERE ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date >= b.start_m
            AND t.transaction_date <= $3
          GROUP BY t.account_id, date_trunc('month', t.transaction_date)
        ),
        month_series AS (
          SELECT gs::DATE AS m FROM bounds b,
            generate_series(b.start_m, b.end_m, '1 month') gs
        )
        SELECT ta.id as account_id, s.m::TEXT as month,
          (ta.opening_balance + COALESCE(pp.total, 0) +
            COALESCE(SUM(mt.total) OVER (
              PARTITION BY ta.id ORDER BY s.m ROWS UNBOUNDED PRECEDING
            ), 0)
          )::NUMERIC as balance
        FROM target_accounts ta
        CROSS JOIN month_series s
        LEFT JOIN pre_period pp ON pp.account_id = ta.id
        LEFT JOIN monthly_tx mt ON mt.account_id = ta.id AND mt.month = s.m
        ORDER BY s.m`,
      [cashIds, start, end],
    );
  }

  /**
   * Rank securities by peak contribution, keep the top `limit` as their own
   * bands, roll the remainder into a single "other" band, and append a cash
   * band when any cash is present. Each band value is rounded to whole units so
   * the stacked bands add up exactly to the point total shown to the user.
   */
  private groupSecurityBreakdown(
    ungrouped: Array<{
      date: string;
      valuesBySec: Map<string, number>;
      cash: number;
      unknownCashAccountIds: string[];
      unpricedSecurityIds: string[];
      missingRatePairs: string[];
    }>,
    securityMap: Map<string, Security>,
    limit: number,
  ): {
    series: InvestmentBreakdownSeries[];
    points: InvestmentBreakdownPoint[];
  } {
    const peak = new Map<string, number>();
    for (const pt of ungrouped) {
      for (const [secId, val] of pt.valuesBySec) {
        if (Math.abs(val) > Math.abs(peak.get(secId) ?? 0)) {
          peak.set(secId, val);
        }
      }
    }

    const rankedSecIds = [...peak.entries()]
      .filter(([, v]) => Math.abs(v) >= 0.005)
      .sort((a, b) => {
        const diff = Math.abs(b[1]) - Math.abs(a[1]);
        if (diff !== 0) return diff;
        const an = securityMap.get(a[0])?.name ?? "";
        const bn = securityMap.get(b[0])?.name ?? "";
        return an.localeCompare(bn);
      })
      .map(([secId]) => secId);

    const topIds = rankedSecIds.slice(0, limit);
    const otherIds = new Set(rankedSecIds.slice(limit));
    const hasOther = otherIds.size > 0;
    const hasCash = ungrouped.some((pt) => Math.abs(pt.cash) >= 0.005);

    const series: InvestmentBreakdownSeries[] = topIds.map((secId) => {
      const sec = securityMap.get(secId);
      return {
        key: secId,
        type: "security",
        symbol: sec?.symbol ?? null,
        name: sec?.name ?? sec?.symbol ?? secId,
      };
    });
    if (hasOther)
      series.push({ key: "other", type: "other", symbol: null, name: "" });
    if (hasCash)
      series.push({ key: "cash", type: "cash", symbol: null, name: "" });

    const points: InvestmentBreakdownPoint[] = ungrouped.map((pt) => {
      const values: Record<string, number> = {};
      let total = 0;
      // Each band and the cash band carry 4dp money precision, not whole units:
      // the bands stack into `total`, so rounding each one lost grosze from the
      // stacked total. Whole-unit rounding is a presentation step at the chart.
      for (const secId of topIds) {
        const v = roundMoney(pt.valuesBySec.get(secId) ?? 0);
        values[secId] = v;
        total += v;
      }
      if (hasOther) {
        let otherSum = 0;
        for (const secId of otherIds)
          otherSum += pt.valuesBySec.get(secId) ?? 0;
        const v = roundMoney(otherSum);
        values.other = v;
        total += v;
      }
      if (hasCash) {
        const v = roundMoney(pt.cash);
        values.cash = v;
        total += v;
      }
      return {
        date: pt.date,
        // Rounded once after summing the 4dp bands so float drift does not leak
        // into the stacked total.
        total: roundMoney(total),
        values,
        cashComplete: pt.unknownCashAccountIds.length === 0,
        unknownCashAccountIds: pt.unknownCashAccountIds,
        pricesComplete: pt.unpricedSecurityIds.length === 0,
        unpricedSecurityIds: pt.unpricedSecurityIds,
        missingRatePairs: pt.missingRatePairs,
      };
    });

    return { series, points };
  }

  private async recalculateRegularAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    const openingBalance = Number(account.openingBalance) || 0;

    const [{ earliest }] = await this.scopedQuery<EarliestRow>(
      `SELECT MIN(transaction_date) as earliest
       FROM transactions
       WHERE account_id = $1
         AND ${ledgerMovementPredicate("")}`,
      [account.id],
    );

    let startDate = this.resolveStartDate(account, earliest);

    // For ASSET with dateAcquired, ensure we start from the earlier of dateAcquired or first tx
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      const daStr = this.toDateString(account.dateAcquired);
      if (daStr < startDate) startDate = daStr;
    }

    const rows = await this.scopedQuery<MonthlyBalanceRow>(
      `WITH monthly_tx_sums AS (
        SELECT DATE_TRUNC('month', transaction_date)::DATE as month,
               SUM(amount) as total
        FROM transactions
        WHERE account_id = $1
          AND ${ledgerMovementPredicate("")}
          AND transaction_date <= CURRENT_DATE
        GROUP BY 1
      )
      SELECT m.month::DATE as month,
             ($2::NUMERIC + COALESCE(
               SUM(mts.total) OVER (ORDER BY m.month ROWS UNBOUNDED PRECEDING),
               0
             )) as balance
      FROM generate_series(
        DATE_TRUNC('month', $3::DATE)::TIMESTAMP,
        DATE_TRUNC('month', CURRENT_DATE)::TIMESTAMP,
        '1 month'::INTERVAL
      ) m(month)
      LEFT JOIN monthly_tx_sums mts ON mts.month = m.month::DATE
      ORDER BY m.month`,
      [account.id, openingBalance, startDate],
    );

    // Determine dateAcquired month for ASSET zeroing
    let dateAcquiredYM: string | null = null;
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      dateAcquiredYM = this.toDateString(account.dateAcquired).substring(0, 7);
    }

    // Atomic delete + insert
    await withScopedDb(this.dataSource, async (m) => {
      await m.query(
        "DELETE FROM monthly_account_balances WHERE account_id = $1",
        [account.id],
      );

      for (const row of rows) {
        const monthStr = this.toDateString(row.month);
        const monthYM = monthStr.substring(0, 7);

        let balance = Number(row.balance);
        if (dateAcquiredYM && monthYM < dateAcquiredYM) {
          balance = 0;
        }

        await m.query(
          `INSERT INTO monthly_account_balances (user_id, account_id, month, balance)
           VALUES ($1, $2, $3::DATE, $4)`,
          [userId, account.id, monthStr, balance],
        );
      }
    });
  }

  private async recalculateBrokerageAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    const openingBalance = Number(account.openingBalance) || 0;

    // Find earliest date from both regular and investment transactions
    const [{ earliest }] = await this.scopedQuery<EarliestRow>(
      `SELECT MIN(transaction_date) as earliest
       FROM transactions
       WHERE account_id = $1
         AND ${ledgerMovementPredicate("")}`,
      [account.id],
    );

    const [{ inv_earliest }] = await this.scopedQuery<InvestmentEarliestRow>(
      `SELECT MIN(transaction_date) as inv_earliest
       FROM investment_transactions
       WHERE account_id = $1
         AND status != 'VOID'`,
      [account.id],
    );

    const dates: string[] = [];
    if (earliest) dates.push(this.toDateString(earliest));
    if (inv_earliest) dates.push(this.toDateString(inv_earliest));
    const startDate =
      dates.length > 0
        ? dates.sort()[0]
        : account.createdAt.toISOString().substring(0, 10);

    // Compute cost-basis via cumulative transaction sums
    const costRows = await this.scopedQuery<MonthlyBalanceRow>(
      `WITH monthly_tx_sums AS (
        SELECT DATE_TRUNC('month', transaction_date)::DATE as month,
               SUM(amount) as total
        FROM transactions
        WHERE account_id = $1
          AND ${ledgerMovementPredicate("")}
          AND transaction_date <= CURRENT_DATE
        GROUP BY 1
      )
      SELECT m.month::DATE as month,
             ($2::NUMERIC + COALESCE(
               SUM(mts.total) OVER (ORDER BY m.month ROWS UNBOUNDED PRECEDING),
               0
             )) as balance
      FROM generate_series(
        DATE_TRUNC('month', $3::DATE)::TIMESTAMP,
        DATE_TRUNC('month', CURRENT_DATE)::TIMESTAMP,
        '1 month'::INTERVAL
      ) m(month)
      LEFT JOIN monthly_tx_sums mts ON mts.month = m.month::DATE
      ORDER BY m.month`,
      [account.id, openingBalance, startDate],
    );

    const costByMonth = new Map<string, number>();
    const months: string[] = [];
    for (const row of costRows) {
      const monthStr = this.toDateString(row.month);
      costByMonth.set(monthStr, Number(row.balance));
      months.push(monthStr);
    }

    // Load investment transactions for holdings replay (exclude future-dated)
    const today = formatDateYMDLocal(new Date());
    const invTxs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where: {
          accountId: account.id,
          transactionDate: LessThanOrEqual(today),
          // Rows as effects: a VOID transaction moved no shares.
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );

    const securityIds = [
      ...new Set(invTxs.filter((t) => t.securityId).map((t) => t.securityId!)),
    ];
    const securities =
      securityIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Preload accepted stored prices for every held security (plus the legacy
    // transaction fallback). Not keyed on skipPriceUpdates -- see
    // loadValuationSeries / positionCloseAsOf (#1242). The window spans the
    // months being (re)built, from the first month through its month end, so
    // every month-end valuation below is covered without loading lifetime
    // history.
    const windowStart = months[0] ?? startDate;
    const windowEnd =
      months.length > 0 ? this.monthEndDate(months[months.length - 1]) : today;
    const { stored: storedPrices, txFallback: txPrices } =
      await this.loadValuationSeries(securityIds, windowStart, windowEnd);

    // Build a rate index for security currencies -> account currency so that
    // per-holding market values (which are stored in the security's native
    // currency) can be converted to the account's currency before being
    // written to monthly_account_balances.market_value. The read path in
    // getMonthlyInvestments converts the stored value from account currency
    // to the user's display currency, so the stored value must be in the
    // account currency.
    const secCurrencies = new Set<string>();
    for (const sec of securities) {
      if (sec.currencyCode && sec.currencyCode !== account.currencyCode) {
        secCurrencies.add(sec.currencyCode);
      }
    }
    const mvRateIndex =
      secCurrencies.size > 0 && months.length > 0
        ? await this.buildRateIndex(
            secCurrencies,
            account.currencyCode,
            months[0],
            months[months.length - 1],
          )
        : new Map();

    // Replay holdings month by month
    const holdings = new Map<string, number>();
    let txIdx = 0;
    const marketValueByMonth = new Map<string, number>();

    for (const monthStr of months) {
      const monthYM = monthStr.substring(0, 7);

      // Process investment transactions up to this month
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txYM = tx.transactionDate.substring(0, 7);
        if (txYM > monthYM) break;

        const secId = tx.securityId;
        const qty = Number(tx.quantity) || 0;

        if (secId) {
          holdings.set(
            secId,
            applyActionToQuantity(holdings.get(secId) || 0, tx.action, qty),
          );
        }
        txIdx++;
      }

      // Compute market value from holdings. Each holding's value is in the
      // security's native currency; convert to the account's currency at the
      // month-end exchange rate before summing.
      const monthValue = new FxAggregate();
      const monthEndStr = this.monthEndDate(monthStr);
      for (const [secId, qty] of holdings) {
        if (Math.abs(qty) < 0.00000001) continue;

        const security = securityMap.get(secId);
        // Latest accepted close on or before month end, from security_prices
        // merged chronologically with the legacy transaction series. #1242.
        const price = positionCloseAsOf(
          storedPrices.get(secId),
          txPrices.get(secId),
          monthEndStr,
        );

        if (price != null) {
          const valueInSecCurrency = qty * price;
          const secCurrency = security?.currencyCode || account.currencyCode;
          monthValue.add(
            this.convertCurrency(
              valueInSecCurrency,
              secCurrency,
              account.currencyCode,
              monthEndStr,
              mvRateIndex,
            ),
            secCurrency,
            account.currencyCode,
          );
        }
      }

      // This value is persisted to monthly_account_balances, which has no
      // column to record that a conversion was incomplete. Per
      // docs/specs/fx-conversion-completeness.md section 5, the snapshot is
      // written from the subtotal and the gap is logged rather than silently
      // absorbed at 1:1; adding a completeness column is a separate migration.
      if (!monthValue.isComplete) {
        this.logger.warn(
          `Snapshot for account ${account.id} month ${monthStr} omits positions with no exchange rate (${monthValue.missingPairs.join(", ")}); the stored market value is a subtotal`,
        );
      }

      marketValueByMonth.set(monthStr, monthValue.knownSubtotal);
    }

    // Atomic write
    await withScopedDb(this.dataSource, async (m) => {
      await m.query(
        "DELETE FROM monthly_account_balances WHERE account_id = $1",
        [account.id],
      );

      for (const monthStr of months) {
        const balance = costByMonth.get(monthStr) ?? 0;
        const mv = marketValueByMonth.get(monthStr) ?? null;

        await m.query(
          `INSERT INTO monthly_account_balances
             (user_id, account_id, month, balance, market_value)
           VALUES ($1, $2, $3::DATE, $4, $5)`,
          [userId, account.id, monthStr, balance, mv],
        );
      }
    });
  }

  /**
   * Accepted stored closes per security (`security_prices.close_price`), sorted
   * oldest-first, for **every** requested security regardless of
   * `skipPriceUpdates`. This is the authoritative valuation source: provider
   * quotes, imports, manual corrections and transaction-derived observations
   * all live here with source precedence already applied at write time. Keying
   * the load on `skipPriceUpdates` -- and then valuing skip-flagged securities
   * from raw transaction prices instead -- is what left a manually corrected
   * 401(k) reporting its old transaction price on every historical chart
   * (issue #1242). That flag is a fetch-eligibility rule, not a valuation one.
   *
   * Bounded to the report window (`[start, end]`) plus the single most recent
   * observation *before* `start`, which is the carry-forward that values the
   * window's first day. Loading the whole lifetime history of every held
   * security to answer a one-week chart is millions of avoidable rows on a
   * large portfolio (review MZ-1242-R4). The pre-window boundary keeps an
   * arbitrarily old sparse/manual price usable without loading everything
   * between it and the window.
   */
  private async loadStoredPriceSeries(
    securityIds: string[],
    start: string,
    end: string,
  ): Promise<Map<string, PricePoint[]>> {
    const result = new Map<string, PricePoint[]>();
    if (securityIds.length === 0) return result;

    const rows = await this.scopedQuery<StoredPriceRow>(
      `WITH boundary AS (
         SELECT DISTINCT ON (security_id) security_id, price_date, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date < $2::DATE
          ORDER BY security_id, price_date DESC
       ),
       windowed AS (
         SELECT security_id, price_date, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date >= $2::DATE
            AND price_date <= $3::DATE
       )
       SELECT security_id, price_date, close_price FROM boundary
       UNION ALL
       SELECT security_id, price_date, close_price FROM windowed
       ORDER BY security_id, price_date`,
      [securityIds, start, end],
    );
    for (const r of rows) {
      const arr = result.get(r.security_id) ?? [];
      arr.push({
        date: this.toDateString(r.price_date),
        close: Number(r.close_price),
      });
      result.set(r.security_id, arr);
    }
    return result;
  }

  /**
   * Transaction-derived closes per security, read directly from
   * `investment_transactions` -- the legacy fallback (see `positionCloseAsOf`).
   * Every accepted transaction observation is normally mirrored into
   * `security_prices`, so this only carries anything for legacy data absent
   * from the store; it is loaded for every security and merged chronologically
   * so a stored series that begins mid-window does not suppress the legacy
   * history that values its earlier dates (review MZ-1242-R1).
   *
   * Same-day trades are averaged and rounded to six decimals
   * (`ROUND(AVG(price), 6)`), reproducing exactly what
   * `SecurityPriceService.upsertTransactionPrice` would have written to
   * `security_prices` (which rounds to 1e-6) -- not the raw driver average,
   * which differs in the last places (review MZ-1242-R8) -- rather than letting
   * the last row of the day stand in for the session. The row filter is
   * `price IS NOT NULL`, matching the canonical writer exactly: a zero-price
   * disposal (a `SELL`/`REDEEM` at $0, which the service allows) is a real
   * observation the writer stores, so excluding it with `price > 0` would let
   * the fallback carry an older price forward where the writer would not
   * (review MZ-1242-R10).
   *
   * Bounded to the window plus one pre-window observation, as the stored loader
   * is. The aggregate is applied *after* the date predicates rather than over
   * an all-time CTE referenced twice: a lifetime aggregate that PostgreSQL 16
   * materializes before filtering scans every transaction of every held
   * security for a one-week report (review MZ-1242-R7). The boundary date is
   * resolved first with a bounded lookup, then only rows on that date and rows
   * inside `[start, end]` are aggregated.
   */
  private async loadTxPriceSeries(
    securityIds: string[],
    start: string,
    end: string,
  ): Promise<Map<string, PricePoint[]>> {
    const result = new Map<string, PricePoint[]>();
    if (securityIds.length === 0) return result;

    const rows = await this.scopedQuery<TransactionPriceRow>(
      `WITH boundary_dates AS (
         SELECT DISTINCT ON (security_id) security_id, transaction_date
           FROM investment_transactions
          WHERE security_id = ANY($1::UUID[])
            AND action = ANY($2)
            AND price IS NOT NULL
            AND status != 'VOID'
            AND transaction_date < $3::DATE
          ORDER BY security_id, transaction_date DESC
       ),
       boundary AS (
         SELECT it.security_id, it.transaction_date,
                ROUND(AVG(it.price::numeric), 6) AS price
           FROM investment_transactions it
           JOIN boundary_dates bd
             ON bd.security_id = it.security_id
            AND bd.transaction_date = it.transaction_date
          WHERE it.action = ANY($2)
            AND it.price IS NOT NULL
            AND it.status != 'VOID'
          GROUP BY it.security_id, it.transaction_date
       ),
       windowed AS (
         SELECT security_id, transaction_date,
                ROUND(AVG(price::numeric), 6) AS price
           FROM investment_transactions
          WHERE security_id = ANY($1::UUID[])
            AND action = ANY($2)
            AND price IS NOT NULL
            AND status != 'VOID'
            AND transaction_date >= $3::DATE
            AND transaction_date <= $4::DATE
          GROUP BY security_id, transaction_date
       )
       SELECT security_id, transaction_date, price FROM boundary
       UNION ALL
       SELECT security_id, transaction_date, price FROM windowed
       ORDER BY security_id, transaction_date`,
      [securityIds, MARKET_PRICED_TRADE_ACTIONS, start, end],
    );
    for (const r of rows) {
      const arr = result.get(r.security_id) ?? [];
      arr.push({
        date: this.toDateString(r.transaction_date),
        close: Number(r.price),
      });
      result.set(r.security_id, arr);
    }
    return result;
  }

  /**
   * The pair `positionCloseAsOf` reads: the accepted stored series and the
   * legacy transaction-derived series, both for every requested security and
   * both bounded to `[start, end]` plus one pre-window observation.
   * `skipPriceUpdates` plays no part -- the store is authoritative and the two
   * are merged chronologically, so an accepted price always wins on its date
   * while legacy history still values dates the store does not reach.
   */
  /**
   * The two price sources `positionCloseAsOf` merges, loaded for a window.
   *
   * Public because `DailyMovementService` values the same positions on the same
   * days and must read the same observations: a second loader would be a second
   * answer to "what priced this holding", which is the disagreement
   * INV-HOLDING-002 exists to prevent.
   */
  async loadValuationSeries(
    securityIds: string[],
    start: string,
    end: string,
  ): Promise<{
    stored: Map<string, PricePoint[]>;
    txFallback: Map<string, PricePoint[]>;
  }> {
    // In turn, not together: on the recalculation path both loads join the
    // caller's transaction, and so its one connection.
    const stored = await this.loadStoredPriceSeries(securityIds, start, end);
    const txFallback = await this.loadTxPriceSeries(securityIds, start, end);
    return { stored, txFallback };
  }

  /**
   * The rate index for a net-worth window.
   *
   * Every monthly series in this service converts its points at the month end
   * (`convertCurrency(..., monthEndDate(month), ...)`), which for a window
   * ending mid-month is later than `endDate`. The conversion horizon is stated
   * here, once, so the loader covers the dates the conversions actually ask
   * about: without it the last month's rate came from whatever observation
   * happened to fall inside the requested window, and the same month's figure
   * differed between a range ending 2024-06-15 and one ending 2024-07-31.
   */
  private buildRateIndex(
    currencies: Set<string>,
    defaultCurrency: string,
    startDate: string,
    endDate: string,
  ): Promise<RateIndex> {
    return buildRateIndex(
      (sql, params) => this.scopedQuery(sql, params),
      currencies,
      defaultCurrency,
      startDate,
      endDate,
      this.monthEndDate(endDate),
    );
  }

  /**
   * Date-aware conversion into the reporting currency. Returns `null` when no
   * rate exists for the pair.
   *
   * `null`, not the amount unchanged: this used to end in `result ?? amount`,
   * which reported 1,000 USD as 1,000 EUR and left a consumer unable to tell
   * that from a genuine 1:1 pair (audit P5-009). The direct/inverse decision,
   * the as-of walk and the look-ahead fallback live in
   * `common/time-series/rate-index.util.ts`, so this service and
   * `DailyBalanceTotalsService` cannot diverge on how a pair resolves. Callers
   * accumulate through `FxAggregate`; see
   * `docs/specs/fx-conversion-completeness.md`.
   */
  private convertCurrency(
    amount: number,
    from: string,
    to: string,
    monthEnd: string,
    rateIndex: RateIndex,
  ): number | null {
    return convertAtDate(amount, from, to, monthEnd, rateIndex, this.logger);
  }

  private resolveStartDate(
    account: Account,
    earliest: DateColumn | null,
  ): string {
    if (earliest) {
      return this.toDateString(earliest);
    }
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      return this.toDateString(account.dateAcquired);
    }
    return account.createdAt.toISOString().substring(0, 10);
  }

  private toDateString(value: string | Date): string {
    if (!value) return new Date().toISOString().substring(0, 10);
    if (typeof value === "string") return value.substring(0, 10);
    return value.toISOString().substring(0, 10);
  }

  private monthEndDate(monthFirstDay: string): string {
    const [y, m] = monthFirstDay.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }
}
