import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { LessThanOrEqual, DataSource, EntityManager, In } from "typeorm";
import { Cron } from "@nestjs/schedule";
import {
  ScheduledTransaction,
  FrequencyType,
} from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import {
  ScheduledTransactionOverride,
  OverrideSplit,
} from "./entities/scheduled-transaction-override.entity";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import { UpdateScheduledTransactionDto } from "./dto/update-scheduled-transaction.dto";
import { CreateScheduledTransactionSplitDto } from "./dto/create-scheduled-transaction-split.dto";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
  OverrideSplitDto,
} from "./dto/scheduled-transaction-override.dto";
import { PostScheduledTransactionDto } from "./dto/post-scheduled-transaction.dto";
import { Tag } from "../tags/entities/tag.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { FUNDING_ACCOUNT_ACTIONS } from "../securities/investment-replay.util";
import {
  Account,
  AccountSubType,
  AccountType,
} from "../accounts/entities/account.entity";
import {
  mortgageTypeOf,
  storesConstantPayment,
} from "../accounts/mortgage-type.util";
import {
  SECURITY_REQUIRED_ACTIONS,
  QUANTITY_PRICE_ACTIONS,
  QUANTITY_ONLY_ACTIONS,
  AMOUNT_ONLY_ACTIONS,
} from "./scheduled-investment-actions";
import {
  ScheduledEffectiveAmountService,
  overrideEffectiveKey,
} from "./scheduled-effective-amount.service";
import {
  ResolvedScheduledOccurrence,
  ScheduledOccurrenceService,
} from "./scheduled-occurrence.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import {
  LoanOccurrencesProjection,
  ScheduledTransactionLoanService,
} from "./scheduled-transaction-loan.service";
import { advanceScheduleCursor } from "./schedule-cursor";
import { addDaysYMD, todayInTimezone, todayYMD } from "../common/date-utils";
import {
  calculateNextDueDate as calcNextDueDate,
  ensureYMD,
} from "../common/recurrence";
import { ActionHistoryService } from "../action-history/action-history.service";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { validateSplitAmountSum } from "../common/split-amount.util";
import { roundMoney, sumMoney } from "../common/round.util";
import {
  applyFxConversion,
  normalizeFxEntry,
  roundFxRate,
} from "../common/fx-entry.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  convertingTotal,
  memoizedRateResolver,
} from "../common/converting-total";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { tr } from "../i18n/translate";

/**
 * What one scheduled occurrence is, for a model reading the list.
 *
 * `unknown` is a real answer, not a gap: an unpriceable mixed-sign split posts on
 * either side of zero, so neither "bill" nor "deposit" is derivable and asserting
 * one gives the model a classification to reason from that the data cannot
 * support (issue #1247 re-audit).
 */
export type LlmScheduledKind =
  "bill" | "deposit" | "transfer" | "investment" | "unknown";

export interface LlmScheduledItem {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  payeeName: string | null;
  categoryName: string | null;
  /**
   * The cash amount this occurrence would post *today*, in `currency` -- the
   * server-resolved effective amount, not the persisted snapshot (issue #1247).
   * `null` when a component of it is unknown (a cross-currency settlement rate
   * that cannot be resolved); never a fallback to the stored `amount`, which was
   * written at whatever rate was current then.
   */
  amount: number | null;
  /** `amount !== null`. False means the current amount could not be determined. */
  amountComplete: boolean;
  /**
   * The currency `amount` is in. For an investment schedule this is the
   * *settlement* currency the cash lands in, not the brokerage account's.
   */
  currency: string;
  frequency: FrequencyType;
  nextDueDate: string;
  daysUntilDue: number;
  isActive: boolean;
  autoPost: boolean;
  kind: LlmScheduledKind;
  description: string | null;
}

export interface LlmUpcomingScheduledResult {
  daysWindow: number;
  itemCount: number;
  overdueCount: number;
  /**
   * `null` when any included bill's current amount is unknown, or when one of
   * them is in a currency with no rate into `totalsCurrency` -- an aggregate is
   * only a total when every component is known AND in one currency, and
   * substituting a stale persisted amount or adding two currencies as numbers
   * both report a confident wrong number (issue #1247).
   * `knownUpcomingBillsSubtotal` then carries what did convert.
   */
  totalUpcomingBills: number | null;
  totalUpcomingDeposits: number | null;
  /**
   * The currency both totals are expressed in: the user's default. Each item
   * keeps its OWN `currency`, which need not be this one -- a scheduled
   * investment settles in its settlement account's currency.
   */
  totalsCurrency: string;
  /** Present only when the matching total is `null`. Never a total's stand-in. */
  knownUpcomingBillsSubtotal?: number;
  knownUpcomingDepositsSubtotal?: number;
  /** False when ANY listed item's current amount is unknown, totals included. */
  amountsComplete: boolean;
  /** The items whose current amount is unknown, so an answer can name them. */
  unknownAmountItems?: string[];
  /**
   * The currency pairs a component could not be converted through, so a withheld
   * total says why rather than leaving a bare `null`. Empty when every component
   * converted.
   */
  missingRatePairs?: string[];
  items: LlmScheduledItem[];
}

export interface LlmScheduledFilter {
  kind?: LlmScheduledKind | "all";
  accountIds?: string[];
  isActive?: boolean;
}

export interface LlmUpcomingFilter extends LlmScheduledFilter {
  days?: number;
}

/**
 * One per-occurrence override as the list read returns it: the stored row plus
 * the server's answer for what that occurrence would post today (issue #1247).
 */
export type ScheduledTransactionOverrideReadModel =
  ScheduledTransactionOverride & {
    investmentForecastAmount: number | null;
    effectiveAmount: number | null;
    effectiveAmountComplete: boolean;
  };

/**
 * A scheduled transaction as `findAll` returns it: the stored row, its
 * overrides, and the effective-amount contract every consumer reads instead of
 * the persisted `amount` (issue #1247).
 *
 * `effectiveAmount` is the cash amount this schedule's un-overridden occurrences
 * would post today, in `effectiveCurrencyCode`; `null` (with
 * `effectiveAmountComplete` false) when a component of it -- today, a
 * cross-currency settlement rate -- cannot be determined. A consumer renders
 * that as unavailable or withholds the total it belongs to; it never falls back
 * to `amount`, which is a snapshot at whatever rate was current when it was
 * written.
 */
export type ScheduledTransactionReadModel = ScheduledTransaction & {
  overrideCount?: number;
  nextOverride?: ScheduledTransactionOverrideReadModel | null;
  futureOverrides?: ScheduledTransactionOverrideReadModel[];
  investmentForecastExchangeRate: number | null;
  investmentForecastAmount: number | null;
  effectiveAmount: number | null;
  effectiveAmountComplete: boolean;
  effectiveCurrencyCode: string;
  /**
   * The account whose balance `effectiveAmount` moves -- the settlement account
   * for an investment schedule (its named funding account, or the brokerage's
   * linked cash account), `accountId` for everything else.
   *
   * The amount is half the answer and the account is the other half: a client
   * projecting a running balance from `accountId` charges the brokerage for cash
   * it never moves, which is how the dashboard's below-zero warning fired on a
   * purchase the funding account covers exactly (issue #1247, INV-OCCURRENCE-003).
   * `effectiveCurrencyCode` is this account's currency by construction, which is
   * what makes the addition sound.
   */
  settlementAccountId: string;
};

/**
 * One occurrence, as a client receives it (issue #1247, INV-OCCURRENCE-003).
 *
 * `amount` is already the effective amount for THIS occurrence -- the override's
 * when one governs it, the schedule's otherwise -- so there is no base-versus-
 * override choice left for a consumer to make, and no persisted snapshot in the
 * payload to reach for. `null` (with `amountComplete` false) means the current
 * amount cannot be determined: render it unavailable and withhold any total
 * containing it.
 *
 * `originalDate` is the recurrence slot (the occurrence's identity, and what an
 * override edit addresses); `dueDate` is when it actually falls.
 */
export interface ScheduledOccurrenceReadModel {
  scheduledTransactionId: string;
  originalDate: string;
  dueDate: string;
  amount: number | null;
  amountComplete: boolean;
  /**
   * The signed amount that decides this occurrence's direction, or `null` when
   * the direction cannot be derived (an unpriceable mixed-sign split posts on
   * either side of zero). A client must not substitute the schedule's stored
   * amount for a `null` here -- that is the substitution `occurrenceKind` exists
   * to prevent.
   */
  directionAmount: number | null;
  currencyCode: string;
  overrideId: string | null;
  /** True when an override moved this occurrence off its recurrence slot. */
  moved: boolean;
  accountId: string;
  transferAccountId: string | null;
  isTransfer: boolean;
}

const INVESTMENT_RELATIONS = [
  "account",
  "payee",
  "category",
  "transferAccount",
  "investmentSecurity",
  "investmentFundingAccount",
  "splits",
  "splits.category",
  "splits.transferAccount",
  "splits.tags",
  "splits.investmentSecurity",
];

/**
 * On an update, an omitted key means "leave the stored value"; an explicit null
 * means "clear it". `??` collapses the two, which let a `{ field: null }` PATCH
 * pass validation against the stored value and then persist the null anyway
 * (issue #1154 review). Use this so validation sees the value that will be
 * written.
 */
function suppliedOrStored<T>(supplied: T | undefined, stored: T): T {
  return supplied === undefined ? stored : supplied;
}

function sameNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Number(left) === Number(right);
}

/**
 * The fields that decide what a post/edit will actually write -- the kind, the
 * accounts money moves between, the amount and currency, and every investment
 * scalar. `post()` and `update()` prepare their writes from a row read before
 * the row lock; if any of these changed by the time the lock is held, the
 * prepared write no longer describes the row and must be refused rather than
 * committing a stale operation (issue #1154 review). Presentation-only content
 * (name/payee, description, memo, tags) is deliberately excluded: it does not
 * change where money moves or how much, so a concurrent cosmetic edit does not
 * force a needless retry. The accepted trade-off is that a post racing such an
 * edit carries the pre-lock text -- the posted transaction may show the older
 * name/description while the schedule already shows the newer one. That is a
 * content-consistency gap, not a financial one, and is chosen over rejecting a
 * post because someone renamed the payee at the same instant.
 */
function sameScheduleMutationBasis(
  a: ScheduledTransaction,
  b: ScheduledTransaction,
): boolean {
  return (
    a.isInvestment === b.isInvestment &&
    a.isTransfer === b.isTransfer &&
    a.isSplit === b.isSplit &&
    a.accountId === b.accountId &&
    a.transferAccountId === b.transferAccountId &&
    a.categoryId === b.categoryId &&
    a.currencyCode === b.currencyCode &&
    sameNullableNumber(
      a.amount as unknown as number,
      b.amount as unknown as number,
    ) &&
    // The foreign-currency tuple is mutable independently of `amount`
    // (`update()` merges it partially, and normalizeFxEntry does not touch the
    // account-currency amount), so a concurrent originalAmount edit would post a
    // stale converted total otherwise (issue #1154 re-review).
    sameNullableNumber(a.originalAmount, b.originalAmount) &&
    a.originalCurrencyCode === b.originalCurrencyCode &&
    sameNullableNumber(a.exchangeRate, b.exchangeRate) &&
    a.investmentAction === b.investmentAction &&
    a.investmentSecurityId === b.investmentSecurityId &&
    a.investmentFundingAccountId === b.investmentFundingAccountId &&
    sameNullableNumber(a.investmentQuantity, b.investmentQuantity) &&
    sameNullableNumber(a.investmentPrice, b.investmentPrice) &&
    sameNullableNumber(a.investmentCommission, b.investmentCommission) &&
    sameNullableNumber(a.investmentTotalAmount, b.investmentTotalAmount) &&
    sameNullableNumber(a.investmentExchangeRate, b.investmentExchangeRate)
  );
}

/**
 * The money-shaping fields of one scheduled split. A split is not presentation
 * metadata: a transfer split creates a counterpart transaction and moves the
 * target account, and an investment split creates an embedded investment. So a
 * post that builds its lines from the base scheduled splits must verify the set
 * did not change under the parent lock (issue #1154 re-review).
 */
function scheduledSplitBasis(split: ScheduledTransactionSplit): string {
  return JSON.stringify({
    id: split.id,
    kind: split.kind,
    categoryId: split.categoryId ?? null,
    transferAccountId: split.transferAccountId ?? null,
    amount: Number(split.amount),
    memo: split.memo ?? null,
    investmentAction: split.investmentAction ?? null,
    investmentSecurityId: split.investmentSecurityId ?? null,
    investmentQuantity:
      split.investmentQuantity == null
        ? null
        : Number(split.investmentQuantity),
    investmentPrice:
      split.investmentPrice == null ? null : Number(split.investmentPrice),
    investmentCommission:
      split.investmentCommission == null
        ? null
        : Number(split.investmentCommission),
    investmentExchangeRate:
      split.investmentExchangeRate == null
        ? null
        : Number(split.investmentExchangeRate),
    tagIds: (split.tags ?? []).map((t) => t.id).sort(),
  });
}

function sameScheduledSplitBasis(
  before: ScheduledTransactionSplit[],
  current: ScheduledTransactionSplit[],
): boolean {
  if (before.length !== current.length) return false;
  const norm = (rows: ScheduledTransactionSplit[]) =>
    rows.map(scheduledSplitBasis).sort();
  const a = norm(before);
  const b = norm(current);
  return a.every((row, i) => row === b[i]);
}

/**
 * Whether two occurrence-override snapshots describe the same effective posting
 * state. Compared alongside `updatedAt` so a same-millisecond timestamp
 * collision is harmless when the values actually differ (issue #1154 re-review).
 */
function sameOverrideMutationBasis(
  before: ScheduledTransactionOverride | null,
  current: ScheduledTransactionOverride | null,
): boolean {
  // null and undefined both mean "no override"; treat them as equal so an
  // override-less post is not falsely flagged as changed.
  if (!before || !current) return !before && !current;
  return (
    before.id === current.id &&
    String(before.overrideDate) === String(current.overrideDate) &&
    sameNullableNumber(before.amount, current.amount) &&
    (before.categoryId ?? null) === (current.categoryId ?? null) &&
    (before.description ?? null) === (current.description ?? null) &&
    (before.isSplit ?? null) === (current.isSplit ?? null) &&
    sameNullableNumber(before.investmentQuantity, current.investmentQuantity) &&
    sameNullableNumber(before.investmentPrice, current.investmentPrice) &&
    sameNullableNumber(
      before.investmentTotalAmount,
      current.investmentTotalAmount,
    ) &&
    JSON.stringify(before.splits ?? null) ===
      JSON.stringify(current.splits ?? null)
  );
}

@Injectable()
export class ScheduledTransactionsService {
  private readonly logger = new Logger(ScheduledTransactionsService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    // forwardRef on the next four: each of these classes sits on a require
    // cycle back to this file, so its reflected parameter type is `undefined`
    // under some load orders and Nest reports "can't resolve dependencies of
    // the ScheduledTransactionsService (..., ?, ...)" at boot. The occurrence
    // pair joined that cycle with issue #1247, through
    // ScheduledEffectiveAmountService -> InvestmentTransactionsService ->
    // AccountsService. See `src/module-graph.spec.ts`.
    @Inject(forwardRef(() => TransactionsService))
    private transactionsService: TransactionsService,
    @Inject(forwardRef(() => InvestmentTransactionsService))
    private investmentTransactionsService: InvestmentTransactionsService,
    // The single server-side answer to "what would this occurrence post today"
    // (issue #1247). Every FX/provenance decision the schedule makes -- the
    // projection, the posting and the read models AI, MCP, the dashboard, the
    // budget and the reports consume -- comes from here, so no surface can grow
    // its own copy of the #1167 rules.
    @Inject(forwardRef(() => ScheduledEffectiveAmountService))
    private effectiveAmounts: ScheduledEffectiveAmountService,
    // The single server-side answer to "which occurrence is due, and when"
    // (issue #1247). Centralizing the arithmetic was half the fix: every surface
    // still chose its own member of the resolver's result, so this owns the
    // recurrence expansion and the override selection as well.
    @Inject(forwardRef(() => ScheduledOccurrenceService))
    private occurrences: ScheduledOccurrenceService,
    private overrideService: ScheduledTransactionOverrideService,
    private loanService: ScheduledTransactionLoanService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRateService: ExchangeRateService,
    // forwardRef: SystemAlertsModule reaches NotificationsModule, which
    // imports this module back -- the edge sits on a require cycle.
    @Inject(forwardRef(() => SystemAlertService))
    private systemAlerts: SystemAlertService,
  ) {}

  @Cron("5 * * * *")
  async processAutoPostTransactions(): Promise<void> {
    this.logger.log("Starting auto-post processing for scheduled transactions");
    // RLS (task C2): the timezone/candidate fan-out queries span users, so the
    // body runs under a system context; each per-user post() re-enters a user
    // context below so it keeps the owner's RLS net.
    return withSystemContext(() => this.processAutoPostWithinContext());
  }

  private async processAutoPostWithinContext(): Promise<void> {
    try {
      const userIdsByTz = await getUsersByEffectiveTimezone(this.dataSource);
      if (userIdsByTz.size === 0) return;

      let totalSuccess = 0;
      let totalError = 0;
      let totalSkipped = 0;

      for (const [tz, userIds] of userIdsByTz) {
        const today = todayInTimezone(tz);
        if (!today) {
          this.logger.warn(
            `Skipping ${userIds.length} user(s) with invalid timezone "${tz}"`,
          );
          continue;
        }

        // One read block per timezone bucket. It must COMMIT before the
        // per-user posting loop below: each post() runs its own user-context
        // transactions, which would otherwise join this system-context one.
        const dueTransactions = await withScopedDb(
          this.dataSource,
          async (m) => {
            const candidates = await m
              .getRepository(ScheduledTransaction)
              .find({
                where: {
                  userId: In(userIds),
                  isActive: true,
                  autoPost: true,
                  nextDueDate: LessThanOrEqual(today) as any,
                },
                relations: INVESTMENT_RELATIONS,
                order: { nextDueDate: "ASC" },
              });

            const postponedIds = await this.findPostponedIds(
              candidates.map((t) => t.id),
              today,
            );
            const dueByDate = candidates.filter((t) => !postponedIds.has(t.id));

            const overrideDueIds = await m
              .getRepository(ScheduledTransactionOverride)
              .createQueryBuilder("o")
              .innerJoin("o.scheduledTransaction", "st")
              .where("st.userId IN (:...userIds)", { userIds })
              .andWhere("o.overrideDate <= :today", { today })
              .andWhere("o.originalDate = st.nextDueDate")
              .andWhere("st.isActive = :active", { active: true })
              .andWhere("st.autoPost = :autoPost", { autoPost: true })
              .select("st.id", "id")
              .distinct(true)
              .getRawMany();

            const dueByDateIds = new Set(dueByDate.map((t) => t.id));
            const overrideOnlyIds = overrideDueIds
              .map((r) => r.id as string)
              .filter((id) => !dueByDateIds.has(id));

            let overrideDueTransactions: ScheduledTransaction[] = [];
            if (overrideOnlyIds.length > 0) {
              overrideDueTransactions = await m
                .getRepository(ScheduledTransaction)
                .find({
                  where: overrideOnlyIds.map((id) => ({ id })),
                  relations: INVESTMENT_RELATIONS,
                });
            }

            return [...dueByDate, ...overrideDueTransactions];
          },
        );
        if (dueTransactions.length === 0) continue;

        for (const scheduled of dueTransactions) {
          try {
            await withUserContext(scheduled.userId, () =>
              // Auto-post: refuse under the lock if the user turned the schedule
              // inactive or off auto-post after cron selected it (issue #1154
              // re-review). The ConflictException is treated as "claimed
              // elsewhere" and skipped below. `expectedDueDate` pins the post
              // to the occurrence selected here, so a replica that loses the
              // race skips rather than posting the next one (issue #1452).
              this.post(scheduled.userId, scheduled.id, undefined, {
                requireActiveAutoPost: true,
                expectedDueDate: ensureYMD(scheduled.nextDueDate),
              }),
            );
            totalSuccess++;
          } catch (error) {
            if (error instanceof ConflictException) {
              // Another replica -- or a manual post -- claimed this occurrence
              // first. Every backend replica fires this cron, so losing the
              // claim is the normal outcome for all but one of them, not a
              // failure: the money was posted exactly once, by the winner.
              totalSkipped++;
              continue;
            }
            if (
              error instanceof NotFoundException &&
              !(await this.scheduleStillExists(scheduled.userId, scheduled.id))
            ) {
              // The cron selected this row moments ago and it is gone: the
              // winning replica posted a ONCE schedule and deleted it inside
              // the same posting transaction (post(): `m.delete(
              // ScheduledTransaction, id)` in the locked claim block), or the
              // user deleted it in between. Neither is "could not be posted".
              //
              // Only when the SCHEDULE is gone. post() also reaches services
              // that throw NotFoundException for a missing account, security
              // or transfer target, and that schedule is genuinely broken: it
              // fails every hour until someone fixes it, so it falls through to
              // the alert below. A NotFoundException alone cannot tell the two
              // apart; the row's existence can.
              this.logger.debug(
                `Auto-post skipped scheduled transaction ${scheduled.id}: ` +
                  "no longer exists (posted and removed elsewhere, or deleted)",
              );
              totalSkipped++;
              continue;
            }
            totalError++;
            this.logger.error(
              `Failed to auto-post "${scheduled.name}" (ID: ${scheduled.id}): ${error.message}`,
              error.stack,
            );
            // Tell the affected user in-app -- this is their money not moving,
            // actionable by them (post it manually from Bills), so it is a
            // per-user alert and not an admin one. `raiseUserAlert` never
            // throws and seeds its own user context, so the loop's isolation
            // holds.
            await this.systemAlerts.raiseUserAlert(scheduled.userId, {
              type: NotificationType.SCHEDULED_POST_FAILED,
              severity: NotificationSeverity.WARNING,
              title: `${scheduled.name} could not be posted`,
              message:
                `Your scheduled transaction "${scheduled.name}" due ` +
                `${scheduled.nextDueDate} failed to post automatically: ` +
                `${String(error.message).slice(0, 300)}. You can post it ` +
                "manually from Bills.",
              // Where the bell -- and now the push / email fan-out -- sends the
              // reader: the Bills page the copy tells them to post from. Without
              // it the deep-link (Phase 3) falls back to the app root.
              target: "/bills",
              data: {
                system: true,
                scheduledId: scheduled.id,
                scheduledName: scheduled.name,
                dueDate: scheduled.nextDueDate,
                error: String(error.message).slice(0, 300),
              },
              dedupeKey:
                `SCHEDULED_POST_FAILED:${scheduled.id}:` +
                new Date().toISOString().slice(0, 10),
            });
          }
        }
      }

      this.logger.log(
        `Auto-post processing complete: ${totalSuccess} succeeded, ` +
          `${totalSkipped} already claimed elsewhere, ${totalError} failed`,
      );
    } catch (error) {
      this.logger.error("Auto-post processing failed", error.stack);
    }
  }

  /**
   * Re-derive the account-currency estimate held in `amount` for every
   * foreign-currency schedule, from the latest stored rate.
   *
   * A scheduled transaction is by definition future-dated, so there is no rate
   * for its due date yet -- the best available answer is today's. Everything
   * that reads `amount` (the bills list, the cash-flow forecast chart, budgets,
   * the upcoming-bills widgets) therefore shows a figure that tracks the market
   * instead of the rate that happened to apply the day the schedule was
   * created. The rate actually used is looked up again for the posting date
   * when the occurrence posts, so this estimate never decides what is booked.
   *
   * Runs 20 minutes past the exchange-rate refresh (5:05 PM New York,
   * Monday-Friday) so it reads rates the same run just stored; on a day the
   * markets are shut it simply does not fire.
   */
  @Cron("25 17 * * 1-5", { timeZone: "America/New_York" })
  async refreshForeignCurrencyEstimates(): Promise<void> {
    // RLS: the sweep spans every user, so the discovery read runs under a
    // system context and each per-user write re-enters that user's context.
    await withSystemContext(() =>
      this.refreshForeignCurrencyEstimatesWithinContext(),
    );
  }

  private async refreshForeignCurrencyEstimatesWithinContext(): Promise<void> {
    try {
      const rows = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(ScheduledTransaction).find({
          where: { isActive: true },
          relations: ["account"],
        }),
      );
      const foreign = rows.filter(
        (r) => r.originalCurrencyCode && r.originalAmount !== null,
      );
      if (foreign.length === 0) return;

      // One lookup per currency pair, not per schedule -- a user with a dozen
      // USD subscriptions on the same card needs exactly one.
      const rateCache = new Map<string, number | null>();
      let updated = 0;

      for (const row of foreign) {
        const pair = `${row.originalCurrencyCode}->${row.currencyCode}`;
        if (!rateCache.has(pair)) {
          rateCache.set(
            pair,
            await this.exchangeRateService.getLatestRate(
              row.originalCurrencyCode as string,
              row.currencyCode,
            ),
          );
        }
        const rate = rateCache.get(pair);
        if (rate === null || rate === undefined || !(rate > 0)) continue;

        const converted = applyFxConversion(
          Number(row.originalAmount),
          rate,
          row.account?.fxFeePercent ?? null,
        );
        const nextRate = roundFxRate(rate);
        if (
          converted.amount === roundMoney(Number(row.amount)) &&
          nextRate === roundFxRate(Number(row.exchangeRate))
        ) {
          continue;
        }

        try {
          await withUserContext(row.userId, () =>
            withScopedDb(this.dataSource, (m) =>
              m.update(ScheduledTransaction, row.id, {
                amount: converted.amount,
                exchangeRate: nextRate,
              }),
            ),
          );
          updated++;
        } catch (error) {
          this.logger.error(
            `Failed to refresh the ${pair} estimate for "${row.name}" (ID: ${row.id}): ${error.message}`,
          );
        }
      }

      this.logger.log(
        `Foreign-currency schedule estimates refreshed: ${updated} of ${foreign.length} updated`,
      );
    } catch (error) {
      this.logger.error(
        "Foreign-currency schedule estimate refresh failed",
        error.stack,
      );
    }
  }

  private async findPostponedIds(
    candidateIds: string[],
    today: string,
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) {
      return new Set();
    }

    const rows = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("o")
        .innerJoin("o.scheduledTransaction", "st")
        .where("o.scheduledTransactionId IN (:...ids)", { ids: candidateIds })
        .andWhere("o.originalDate = st.nextDueDate")
        .andWhere("o.overrideDate > :today", { today })
        .select("o.scheduledTransactionId", "id")
        .distinct(true)
        .getRawMany(),
    );

    return new Set(rows.map((r) => r.id as string));
  }

  async create(
    userId: string,
    createDto: CreateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    if (createDto.isInvestment && createDto.isTransfer) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.notTransferAndInvestment",
          "A scheduled transaction cannot be both a transfer and an investment",
        ),
      );
    }

    const account = await this.accountsService.findOne(
      userId,
      createDto.accountId,
    );

    if (createDto.isTransfer && createDto.transferAccountId) {
      await this.accountsService.findOne(userId, createDto.transferAccountId);
      if (createDto.transferAccountId === createDto.accountId) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.sameSourceAndDestination",
            "Source and destination accounts must be different",
          ),
        );
      }
    }

    if (createDto.isInvestment) {
      if (account.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.requiresBrokerageAccount",
            "Scheduled investment transactions require a brokerage account",
          ),
        );
      }
      this.validateInvestmentFields(createDto);
      // Only validate a funding account the action will actually use; a value
      // supplied for a non-BUY/SELL action is dropped at persist time, so
      // rejecting it here would refuse a request the write would have cleaned.
      if (
        createDto.investmentAction &&
        FUNDING_ACCOUNT_ACTIONS.has(createDto.investmentAction) &&
        createDto.investmentFundingAccountId
      ) {
        await this.accountsService.findOne(
          userId,
          createDto.investmentFundingAccountId,
        );
      }
    }

    const {
      splits,
      isTransfer,
      transferAccountId,
      isInvestment,
      ...transactionData
    } = createDto;
    const hasSplits = !isInvestment && splits && splits.length > 0;

    if (hasSplits && !isTransfer) {
      this.validateSplits(splits, createDto.amount);
    }

    const fx = this.resolveScheduleFx(createDto, account.currencyCode, {
      isSplit: !!(hasSplits && !isTransfer),
      isTransfer: !!isTransfer,
      isInvestment: !!isInvestment,
    });

    // Record the currency pair a stored investment rate belongs to (issue
    // #1167). Only resolved when a rate is actually supplied, so a rateless
    // investment schedule adds no reads and no new failure modes.
    const investmentRateProvenance = isInvestment
      ? await this.effectiveAmounts.resolveInvestmentRateProvenance(
          userId,
          transactionData.investmentExchangeRate,
          {
            accountId: transactionData.accountId,
            fundingAccountId: FUNDING_ACCOUNT_ACTIONS.has(
              transactionData.investmentAction as InvestmentAction,
            )
              ? transactionData.investmentFundingAccountId
              : null,
            securityId: transactionData.investmentSecurityId,
          },
        )
      : { from: null, to: null };

    const saved = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(ScheduledTransaction);
      const scheduledTransaction = repo.create({
        ...transactionData,
        userId,
        startDate: transactionData.startDate || transactionData.nextDueDate,
        totalOccurrences: transactionData.occurrencesRemaining,
        // A transfer may carry an optional spending category (see #743): it is
        // stored on the schedule and applied to both legs when posted, surfacing
        // the transfer in the monthly category breakdown. Only splits (category
        // lives on each split) and investments null it out here.
        categoryId:
          hasSplits || isInvestment ? null : transactionData.categoryId,
        originalAmount: fx.originalAmount,
        originalCurrencyCode: fx.originalCurrencyCode,
        exchangeRate: fx.exchangeRate,
        isSplit: hasSplits && !isTransfer,
        isTransfer: isTransfer || false,
        transferAccountId: isTransfer ? transferAccountId : null,
        isInvestment: isInvestment || false,
        investmentAction: isInvestment
          ? (transactionData.investmentAction as InvestmentAction)
          : null,
        investmentSecurityId: isInvestment
          ? transactionData.investmentSecurityId || null
          : null,
        // A funding account only belongs on a BUY/SELL; storing one on any other
        // action is what later misroutes the posted cash (issue #1154).
        investmentFundingAccountId:
          isInvestment &&
          FUNDING_ACCOUNT_ACTIONS.has(
            transactionData.investmentAction as InvestmentAction,
          )
            ? transactionData.investmentFundingAccountId || null
            : null,
        investmentQuantity:
          isInvestment && transactionData.investmentQuantity !== undefined
            ? transactionData.investmentQuantity
            : null,
        investmentPrice:
          isInvestment && transactionData.investmentPrice !== undefined
            ? transactionData.investmentPrice
            : null,
        investmentCommission:
          isInvestment && transactionData.investmentCommission !== undefined
            ? transactionData.investmentCommission
            : null,
        investmentTotalAmount:
          isInvestment && transactionData.investmentTotalAmount !== undefined
            ? transactionData.investmentTotalAmount
            : null,
        investmentExchangeRate:
          isInvestment && transactionData.investmentExchangeRate !== undefined
            ? transactionData.investmentExchangeRate
            : null,
        investmentExchangeRateFromCurrency: investmentRateProvenance.from,
        investmentExchangeRateToCurrency: investmentRateProvenance.to,
      });

      const savedRow = await repo.save(scheduledTransaction);

      if (hasSplits && !isTransfer) {
        // Create: the split rates are freshly supplied, so stamp their pair.
        await this.createSplits(
          savedRow.id,
          splits,
          m,
          userId,
          account.id,
          "fresh",
        );
      }

      return savedRow;
    });

    const result = await this.findOne(userId, saved.id);

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_transaction",
      entityId: result.id,
      action: "create",
      afterData: { ...result },
      description: `Created scheduled transaction "${result.name}"`,
      descriptionKey: "createdScheduledTransaction",
      descriptionParams: { name: result.name },
    });

    return result;
  }

  /**
   * Normalize the foreign-currency entry on a create/update payload against the
   * account currency, and return the trio to persist alongside `amount`.
   *
   * Foreign-currency entry is offered on a plain scheduled transaction only.
   * A transfer already has its own cross-currency handling (each leg is in its
   * own account's currency), an investment carries its own
   * `investmentExchangeRate`, and a split stores per-split amounts in the
   * account currency that could not be re-derived when the rate moves -- so
   * each of those rejects the fields rather than silently dropping them.
   */
  private resolveScheduleFx(
    dto: {
      amount?: number;
      originalAmount?: number | null;
      originalCurrencyCode?: string | null;
      exchangeRate?: number | null;
    },
    accountCurrencyCode: string,
    kind: { isSplit: boolean; isTransfer: boolean; isInvestment: boolean },
  ): {
    originalAmount: number | null;
    originalCurrencyCode: string | null;
    exchangeRate: number;
  } {
    const fx = normalizeFxEntry(
      {
        originalAmount: dto.originalAmount,
        originalCurrencyCode: dto.originalCurrencyCode,
        exchangeRate: dto.exchangeRate,
        amount: Number(dto.amount ?? 0),
      },
      accountCurrencyCode,
    );

    if (
      fx.originalCurrencyCode &&
      (kind.isSplit || kind.isTransfer || kind.isInvestment)
    ) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.fxPlainOnly",
          "A different currency can only be used on a plain scheduled transaction, not a split, transfer or investment",
        ),
      );
    }

    return {
      ...fx,
      exchangeRate: fx.originalCurrencyCode
        ? roundFxRate(Number(dto.exchangeRate))
        : 1,
    };
  }

  private validateInvestmentFields(dto: {
    investmentAction?: InvestmentAction | null;
    investmentSecurityId?: string | null;
    investmentQuantity?: number | null;
    investmentPrice?: number | null;
    investmentTotalAmount?: number | null;
    investmentExchangeRate?: number | null;
  }): void {
    const action = dto.investmentAction;
    if (!action) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.investmentActionRequired",
          "Investment action is required for scheduled investment transactions",
        ),
      );
    }
    if (SECURITY_REQUIRED_ACTIONS.has(action) && !dto.investmentSecurityId) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.actionRequiresSecurity",
          `Action ${action} requires a security`,
          { action },
        ),
      );
    }
    if (QUANTITY_PRICE_ACTIONS.has(action)) {
      if (
        dto.investmentQuantity === undefined ||
        dto.investmentQuantity === null ||
        Number(dto.investmentQuantity) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresPositiveQuantity",
            `Action ${action} requires a positive quantity`,
            { action },
          ),
        );
      }
      if (
        dto.investmentPrice === undefined ||
        dto.investmentPrice === null ||
        Number(dto.investmentPrice) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresPositivePrice",
            `Action ${action} requires a positive price`,
            { action },
          ),
        );
      }
    } else if (QUANTITY_ONLY_ACTIONS.has(action)) {
      if (
        dto.investmentQuantity === undefined ||
        dto.investmentQuantity === null ||
        Number(dto.investmentQuantity) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresPositiveQuantity",
            `Action ${action} requires a positive quantity`,
            { action },
          ),
        );
      }
    } else if (AMOUNT_ONLY_ACTIONS.has(action)) {
      if (
        dto.investmentTotalAmount === undefined ||
        dto.investmentTotalAmount === null ||
        Number(dto.investmentTotalAmount) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresTotalAmount",
            `Action ${action} requires a total amount`,
            { action },
          ),
        );
      }
    }

    // An exchange rate, when present, must be a real rate on every action --
    // zero or negative can never settle (issue #1154 review). A missing rate is
    // fine here: it is resolved for the posting date at post time. Reuses the
    // securities catalog key rather than adding a new one.
    if (
      dto.investmentExchangeRate !== undefined &&
      dto.investmentExchangeRate !== null &&
      (!Number.isFinite(Number(dto.investmentExchangeRate)) ||
        Number(dto.investmentExchangeRate) <= 0)
    ) {
      throw new BadRequestException(
        tr(
          "errors.securities.exchangeRateNotPositive",
          "Exchange rate must be greater than zero",
        ),
      );
    }
  }

  private validateSplits(
    splits: CreateScheduledTransactionSplitDto[],
    transactionAmount: number,
  ): void {
    validateSplitAmountSum(splits, transactionAmount, {
      allowSinglePassthrough: true,
      isPassthrough: (s) => {
        const split = s as CreateScheduledTransactionSplitDto;
        return Boolean(split.transferAccountId || split.investment);
      },
    });
  }

  /**
   * Each existing investment split's stored rate and the pair it recorded, keyed
   * by security id (issue #1167). All splits for one security share one pair, so
   * the map is unambiguous; only splits that carry a rate and a complete pair are
   * included. The rate is kept so the update can tell a *resent-unchanged* rate
   * (carry the old pair forward) from a *genuinely re-entered* one (stamp the
   * current pair) -- provenance belongs to the rate+pair tuple, not the security.
   */
  // Provenance carry-forward is keyed by security id AND the stored rate, never
  // by security id alone (issue #1167 F5-3). One schedule can hold two investment
  // splits for the *same* security with *different* stored rates; keyed by
  // security alone the second overwrites the first, so the first's resent-unchanged
  // rate no longer matches any entry and is wrongly treated as "changed" -- which
  // stamps the current pair onto a stale rate. The rate is part of the identity of
  // the tuple whose pair we are preserving, so it belongs in the key.
  private provenanceKey(securityId: string, rate: number): string {
    return `${securityId}::${rate}`;
  }

  /**
   * Provenance carry-forward source (issue #1167 F4). Indexed two ways:
   *   - `byId`: the split's stable id -> its recorded {rate, pair}. This is the
   *     authoritative correlation -- the client echoes the source split's id so a
   *     user-changed rate is distinguished from an unchanged one by *identity*,
   *     not by matching rate values (two same-security splits swapping rates
   *     collide under a value key).
   *   - `byKey`: `provenanceKey(securityId, rate)` -> pair. The fallback for a
   *     client that sends no `sourceSplitId` (older UI, or the general form),
   *     which still carries an unchanged rate's pair the way F5-3 did.
   *
   * `byId` includes a legacy row whose pair is NULL (a rate stored before #1167
   * backfilled no provenance), carrying `from: null, to: null` (R7-F2). Identity
   * must exist independently of whether provenance does: otherwise an unchanged
   * legacy scalar is absent from `byId`, treated as fresh on a cosmetic edit, and
   * stamped with the current pair -- re-blessing exactly the stale rate #1167
   * forbids. `byKey` still carries only complete pairs (a null pair cannot be
   * "carried" by value).
   */
  private buildSplitProvenanceSource(splits: ScheduledTransactionSplit[]): {
    byId: Map<
      string,
      { rate: number | null; from: string | null; to: string | null }
    >;
    byKey: Map<string, { from: string; to: string }>;
  } {
    const byId = new Map<
      string,
      { rate: number | null; from: string | null; to: string | null }
    >();
    const byKey = new Map<string, { from: string; to: string }>();
    for (const s of splits) {
      const isInvestmentRate =
        s.kind === SplitKind.INVESTMENT &&
        s.investmentSecurityId &&
        s.investmentExchangeRate !== null &&
        s.investmentExchangeRate !== undefined;
      if (isInvestmentRate) {
        const rate = Number(s.investmentExchangeRate);
        const from = s.investmentExchangeRateFromCurrency ?? null;
        const to = s.investmentExchangeRateToCurrency ?? null;
        if (from && to && s.investmentSecurityId) {
          byKey.set(this.provenanceKey(s.investmentSecurityId, rate), {
            from,
            to,
          });
        }
        if (s.id) byId.set(s.id, { rate, from, to });
      } else if (s.id) {
        // Every source split has an identity, even one that carried no investment
        // rate (a category/transfer split, or an investment line with no stored
        // rate). Recording it with rate=null lets the decision tell "a valid line
        // converted into an investment, whose new rate is fresh" (R9-F2) from "a
        // claimed id that does not exist" (unverifiable, R7-F2).
        byId.set(s.id, { rate: null, from: null, to: null });
      }
    }
    return { byId, byKey };
  }

  /**
   * Build the same provenance source shape from an occurrence override's stored
   * jsonb splits (issue #1167 R9), so `createOverride`/`updateOverride` decide by
   * the same rule as scheduled splits. Every split with an id is recorded; a line
   * with no investment rate carries rate=null.
   */
  private buildOverrideProvenanceSource(
    splits: OverrideSplit[] | null | undefined,
  ): {
    byId: Map<
      string,
      { rate: number | null; from: string | null; to: string | null }
    >;
    byKey: Map<string, { from: string; to: string }>;
  } {
    const byId = new Map<
      string,
      { rate: number | null; from: string | null; to: string | null }
    >();
    const byKey = new Map<string, { from: string; to: string }>();
    for (const s of splits ?? []) {
      const inv = s.investment;
      const isInvestmentRate =
        inv?.securityId &&
        inv.exchangeRate !== null &&
        inv.exchangeRate !== undefined;
      if (isInvestmentRate) {
        const rate = Number(inv!.exchangeRate);
        const from = inv!.exchangeRateFromCurrency ?? null;
        const to = inv!.exchangeRateToCurrency ?? null;
        if (from && to && inv!.securityId) {
          byKey.set(this.provenanceKey(inv!.securityId, rate), { from, to });
        }
        if (s.id) byId.set(s.id, { rate, from, to });
      } else if (s.id) {
        byId.set(s.id, { rate: null, from: null, to: null });
      }
    }
    return { byId, byKey };
  }

  /**
   * The single provenance decision (issue #1167 R9), shared by create and update
   * of both scheduled splits and occurrence overrides -- there is exactly one
   * rule, so it cannot drift between the four write paths.
   *
   * Given an incoming investment line (its claimed source id, its `rateExplicit`
   * new-line/edit marker, its security and rate) and the source rows it may
   * continue, return the currency pair to persist beside its rate:
   *   - a matched source whose stored investment rate is unchanged, and the user
   *     did not re-enter it (`!rateExplicit`), preserves the source pair exactly
   *     (including a legacy null/null -- never re-derive a stale scalar's pair);
   *   - a matched source that was NOT an investment-with-rate (a converted
   *     category/transfer line, `src.rate === null`), a changed rate, or an
   *     explicit re-entry, stamps the current pair;
   *   - a claimed id that matches nothing is unverifiable -> unprovenanced;
   *   - no id but `rateExplicit` (a genuinely new line) stamps the current pair;
   *   - no id, unmarked: carry a still-complete pair by exact security+rate, else
   *     leave unprovenanced so posting re-resolves (never stamp, R8-F2).
   */
  private async decideSplitProvenance(
    incoming: {
      sourceSplitId?: string | null;
      rateExplicit?: boolean;
      // Null for a security-less investment split (e.g. INTEREST): the source
      // currency is the account's, resolvable server-side, but there is no
      // security to key the value-carry fallback by.
      securityId: string | null;
      rate: number;
    },
    source: {
      byId: Map<
        string,
        { rate: number | null; from: string | null; to: string | null }
      >;
      byKey: Map<string, { from: string; to: string }>;
    },
    stampCurrent: () => Promise<{ from: string | null; to: string | null }>,
  ): Promise<{ from: string | null; to: string | null }> {
    if (incoming.sourceSplitId) {
      const src = source.byId.get(incoming.sourceSplitId);
      if (!src) return { from: null, to: null };
      if (
        src.rate !== null &&
        src.rate === incoming.rate &&
        !incoming.rateExplicit
      ) {
        return { from: src.from, to: src.to };
      }
      // A matched source that carried NO investment rate (src.rate === null: a
      // category/transfer line, or a legacy investment split with unknown FX)
      // acquires the current pair only when the rate is proven fresh -- the user
      // marked it `rateExplicit`. Otherwise it stays unprovenanced and posting
      // re-resolves it: stamping here would bless a synthetic scalar (e.g. a null
      // rate the client serialized as 1) as the current cross-currency rate
      // (issue #1167 R10-F1).
      if (src.rate === null && !incoming.rateExplicit) {
        return { from: null, to: null };
      }
      return stampCurrent();
    }
    if (incoming.rateExplicit) return stampCurrent();
    // The value-carry fallback is keyed by security: without one (a security-less
    // split with no sourceSplitId and no explicit intent) there is nothing to
    // match against, so the rate is unprovenanced and posting re-resolves it --
    // never the client-echoed pair.
    if (incoming.securityId === null) return { from: null, to: null };
    const carried = source.byKey.get(
      this.provenanceKey(incoming.securityId, incoming.rate),
    );
    return carried
      ? { from: carried.from, to: carried.to }
      : { from: null, to: null };
  }

  private async createSplits(
    scheduledTransactionId: string,
    splits: CreateScheduledTransactionSplitDto[],
    manager: EntityManager,
    // The owner and the parent schedule's account, needed to record the
    // currency-pair provenance of any per-split investment rate (issue #1167).
    // An embedded investment split settles through the parent INVESTMENT_CASH
    // account, so there is no separate funding account.
    userId: string,
    accountId: string,
    // How to record the currency-pair provenance of each per-split investment
    // rate (issue #1167):
    //   - "fresh" (schedule create): the rate is genuinely new, so stamp the
    //     current settlement pair.
    //   - a `SplitProvenanceSource` (schedule update): provenance belongs to the
    //     rate+pair tuple, so only a *resent-unchanged* rate carries the old pair
    //     forward -- a rate whose pair is unchanged keeps working, and one whose
    //     currency has since changed is caught at posting because its old pair no
    //     longer matches. A *changed* rate (the user re-entered it) or a new
    //     security is fresh, so it stamps the current pair. Which incoming split
    //     "is" which old split is decided by `sourceSplitId` identity (F4), with a
    //     value-key fallback for a client that sends none.
    provenanceSource:
      | "fresh"
      | {
          byId: Map<
            string,
            { rate: number | null; from: string | null; to: string | null }
          >;
          byKey: Map<string, { from: string; to: string }>;
        },
  ): Promise<ScheduledTransactionSplit[]> {
    const savedSplits: ScheduledTransactionSplit[] = [];

    // Batch-fetch every tag referenced across all splits so the per-split
    // tag assignment doesn't trigger one `findBy(Tag, ...)` query per row
    // (the prior N+1 pattern).
    const allTagIds = Array.from(
      new Set(splits.flatMap((s) => s.tagIds ?? [])),
    );
    const tagsById =
      allTagIds.length > 0
        ? new Map(
            (await manager.findBy(Tag, { id: In(allTagIds) })).map((t) => [
              t.id,
              t,
            ]),
          )
        : new Map<string, Tag>();

    for (const split of splits) {
      const inferredKind: SplitKind = split.splitKind
        ? split.splitKind
        : split.investment
          ? SplitKind.INVESTMENT
          : split.transferAccountId
            ? SplitKind.TRANSFER
            : SplitKind.CATEGORY;

      const isInvestmentSplit =
        inferredKind === SplitKind.INVESTMENT && !!split.investment;
      const splitHasRate =
        isInvestmentSplit && split.investment!.exchangeRate != null;
      let investmentRateProvenance: {
        from: string | null;
        to: string | null;
      } = { from: null, to: null };
      if (splitHasRate) {
        const incomingRate = Number(split.investment!.exchangeRate);
        const securityId = split.investment!.securityId;
        if (securityId) {
          const stampCurrent = () =>
            this.effectiveAmounts.resolveInvestmentRateProvenance(
              userId,
              incomingRate,
              {
                accountId,
                fundingAccountId: null,
                securityId,
              },
            );
          investmentRateProvenance =
            provenanceSource === "fresh"
              ? // A brand-new schedule: every line's rate is for the current pair.
                await stampCurrent()
              : await this.decideSplitProvenance(
                  {
                    sourceSplitId: split.sourceSplitId,
                    rateExplicit: split.rateExplicit,
                    securityId,
                    rate: incomingRate,
                  },
                  provenanceSource,
                  stampCurrent,
                );
        }
      }

      const entity = manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId,
        kind: inferredKind,
        categoryId:
          inferredKind === SplitKind.CATEGORY ? split.categoryId || null : null,
        transferAccountId:
          inferredKind === SplitKind.TRANSFER
            ? split.transferAccountId || null
            : null,
        amount: split.amount,
        memo: split.memo || null,
        investmentAction:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? split.investment.action
            : null,
        investmentSecurityId:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? split.investment.securityId || null
            : null,
        investmentQuantity:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.quantity ?? null)
            : null,
        investmentPrice:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.price ?? null)
            : null,
        investmentCommission:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.commission ?? null)
            : null,
        investmentExchangeRate:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.exchangeRate ?? null)
            : null,
        investmentExchangeRateFromCurrency: investmentRateProvenance.from,
        investmentExchangeRateToCurrency: investmentRateProvenance.to,
      });

      const saved = await manager.save(entity);

      if (split.tagIds && split.tagIds.length > 0) {
        saved.tags = split.tagIds
          .map((id) => tagsById.get(id))
          .filter((t): t is Tag => t != null);
        await manager.save(saved);
      }

      savedSplits.push(saved);
    }

    return savedSplits;
  }

  async findAll(userId: string): Promise<ScheduledTransactionReadModel[]> {
    const rows = await withScopedDb(this.dataSource, async (m) => {
      const transactions = await m
        .getRepository(ScheduledTransaction)
        .createQueryBuilder("st")
        .leftJoinAndSelect("st.account", "account")
        .leftJoinAndSelect("st.payee", "payee")
        .leftJoinAndSelect("st.category", "category")
        .leftJoinAndSelect("st.transferAccount", "transferAccount")
        .leftJoinAndSelect("st.investmentSecurity", "investmentSecurity")
        .leftJoinAndSelect(
          "st.investmentFundingAccount",
          "investmentFundingAccount",
        )
        .leftJoinAndSelect("st.splits", "splits")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
        .leftJoinAndSelect("splits.tags", "splitTags")
        .leftJoinAndSelect(
          "splits.investmentSecurity",
          "splitInvestmentSecurity",
        )
        .where("st.userId = :userId", { userId })
        .orderBy("st.nextDueDate", "ASC")
        .getMany();

      if (transactions.length === 0) {
        return [];
      }

      const txDueDates = new Map<string, string>();
      const txIds = transactions.map((t) => {
        const d = ensureYMD(t.nextDueDate);
        txDueDates.set(t.id, d);
        return t.id;
      });

      const nextOverridesQuery = m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("override")
        .leftJoinAndSelect("override.category", "category");

      const orConditions: string[] = [];
      const params: Record<string, string> = {};
      txIds.forEach((id, i) => {
        orConditions.push(
          `(override.scheduledTransactionId = :id${i} AND override.originalDate = :date${i})`,
        );
        params[`id${i}`] = id;
        params[`date${i}`] = txDueDates.get(id)!;
      });
      nextOverridesQuery.where(orConditions.join(" OR "), params);

      const allNextOverrides = await nextOverridesQuery.getMany();
      const nextOverrideMap = new Map<string, ScheduledTransactionOverride>();
      for (const o of allNextOverrides) {
        nextOverrideMap.set(o.scheduledTransactionId, o);
      }

      // Fetch ALL future overrides (on or after each transaction's nextDueDate)
      const allFutureOverrides = await m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("override")
        .leftJoinAndSelect("override.category", "category")
        .where("override.scheduledTransactionId IN (:...txIds)", { txIds })
        .orderBy("override.originalDate", "ASC")
        .getMany();

      // Group overrides by transaction and filter to future-only
      const futureOverridesMap = new Map<
        string,
        ScheduledTransactionOverride[]
      >();
      const countMap = new Map<string, number>();
      for (const o of allFutureOverrides) {
        const dueDate = txDueDates.get(o.scheduledTransactionId);
        if (!dueDate) continue;
        const origDate = String(o.originalDate).split("T")[0];
        if (origDate >= dueDate) {
          const list = futureOverridesMap.get(o.scheduledTransactionId) || [];
          list.push(o);
          futureOverridesMap.set(o.scheduledTransactionId, list);
          countMap.set(
            o.scheduledTransactionId,
            (countMap.get(o.scheduledTransactionId) || 0) + 1,
          );
        }
      }

      return transactions.map((transaction) => ({
        ...transaction,
        overrideCount: countMap.get(transaction.id) || 0,
        nextOverride: nextOverrideMap.get(transaction.id) || null,
        futureOverrides: futureOverridesMap.get(transaction.id) || [],
      }));
    });

    // Resolve the effective amount for each schedule OUTSIDE the list
    // transaction (issue #1167). The provider-capable rate path can perform an
    // external fetch and persist the result, which must not run inside the long
    // read transaction. `ScheduledEffectiveAmountService` owns the FX caches, the
    // provenance rules and the combination of rate and stored scalar, so this
    // list read and every other consumer (AI, MCP, dashboard, budget, reports)
    // read one server-authoritative answer rather than each deriving its own
    // (issue #1247).
    const effective = await this.effectiveAmounts.resolveMany(userId, rows);

    return rows.map((row) => {
      const resolved = effective.get(row.id)!;
      // Each override that carries an investment gets its own effective total
      // too (#1167 F5-2): a per-occurrence override is FX-sensitive the same way
      // the base schedule is, and its stored `amount` is a stale snapshot once a
      // security's currency changes. Return new objects rather than mutating the
      // loaded entities in place (immutability rule): the override entities are
      // shared read models, and stamping a derived field onto them here mutates
      // what other readers of the same transaction hold.
      const augmentOverride = (override: ScheduledTransactionOverride) => {
        const own = resolved.overrides.get(overrideEffectiveKey(override));
        return {
          ...override,
          investmentForecastAmount: own?.investmentForecastAmount ?? null,
          effectiveAmount: own?.effective.amount ?? null,
          effectiveAmountComplete: own?.effective.complete ?? false,
          effectiveDirectionAmount: own?.effective.directionAmount ?? null,
        };
      };
      return {
        ...row,
        nextOverride: row.nextOverride
          ? augmentOverride(row.nextOverride)
          : null,
        futureOverrides: row.futureOverrides?.map(augmentOverride),
        investmentForecastExchangeRate: resolved.investmentForecastExchangeRate,
        investmentForecastAmount: resolved.investmentForecastAmount,
        effectiveAmount: resolved.base.amount,
        effectiveAmountComplete: resolved.base.complete,
        effectiveCurrencyCode: resolved.base.currencyCode,
        // The account that effective amount belongs to, so no client has to
        // re-derive "which account settles this" (issue #1247).
        settlementAccountId: resolved.settlementAccountId,
        // Whether the direction is derivable at all, so a client never has to
        // reach for the snapshot's sign (issue #1247 re-audit).
        effectiveDirectionAmount: resolved.base.directionAmount,
      };
    });
  }

  async findOne(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransaction).findOne({
        where: { id, userId },
        relations: INVESTMENT_RELATIONS,
      }),
    );

    if (!scheduled) {
      throw new NotFoundException(
        tr(
          "errors.scheduled.notFound",
          `Scheduled transaction with ID ${id} not found`,
          { id },
        ),
      );
    }

    return scheduled;
  }

  /**
   * Whether the schedule row is still there, read under the owner's context.
   *
   * The auto-post cron asks this after a NotFoundException to tell "the
   * schedule is gone" (posted and removed by another replica, or deleted) from
   * "something the schedule points at is gone" (an account or security), which
   * throw the same exception. A read that fails answers `true`: an unknown
   * outcome must reach the user as an alert, never be skipped as "gone".
   */
  private async scheduleStillExists(
    userId: string,
    id: string,
  ): Promise<boolean> {
    try {
      const count = await withUserContext(userId, () =>
        withScopedDb(this.dataSource, (m) =>
          m
            .getRepository(ScheduledTransaction)
            .count({ where: { id, userId } }),
        ),
      );
      return count > 0;
    } catch {
      return true;
    }
  }

  async findDue(userId: string): Promise<ScheduledTransaction[]> {
    const today = todayYMD();

    return withScopedDb(this.dataSource, async (m) => {
      const candidates = await m.getRepository(ScheduledTransaction).find({
        where: {
          userId,
          isActive: true,
          nextDueDate: LessThanOrEqual(today) as any,
        },
        relations: INVESTMENT_RELATIONS,
        order: { nextDueDate: "ASC" },
      });

      // Defer candidates whose next occurrence has an override pushing the
      // effective date past today.
      const postponedIds = await this.findPostponedIds(
        candidates.map((t) => t.id),
        today,
      );
      const dueByDate = candidates.filter((t) => !postponedIds.has(t.id));

      // Also find transactions with overrides that moved the date earlier
      const overrideDueIds = await m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("o")
        .innerJoin("o.scheduledTransaction", "st")
        .where("o.overrideDate <= :today", { today })
        .andWhere("o.originalDate = st.nextDueDate")
        .andWhere("st.userId = :userId", { userId })
        .andWhere("st.isActive = :active", { active: true })
        .select("st.id", "id")
        .distinct(true)
        .getRawMany();

      const dueByDateIds = new Set(dueByDate.map((t) => t.id));
      const overrideOnlyIds = overrideDueIds
        .map((r) => r.id as string)
        .filter((id) => !dueByDateIds.has(id));

      if (overrideOnlyIds.length === 0) {
        return dueByDate;
      }

      const overrideDueTransactions = await m
        .getRepository(ScheduledTransaction)
        .find({
          where: overrideOnlyIds.map((id) => ({ id })),
          relations: INVESTMENT_RELATIONS,
        });

      return [...dueByDate, ...overrideDueTransactions];
    });
  }

  async findUpcoming(
    userId: string,
    days: number = 30,
  ): Promise<ScheduledTransaction[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(ScheduledTransaction)
        .createQueryBuilder("st")
        .leftJoinAndSelect("st.account", "account")
        .leftJoinAndSelect("st.payee", "payee")
        .leftJoinAndSelect("st.category", "category")
        .leftJoinAndSelect("st.transferAccount", "transferAccount")
        .leftJoinAndSelect("st.investmentSecurity", "investmentSecurity")
        .leftJoinAndSelect(
          "st.investmentFundingAccount",
          "investmentFundingAccount",
        )
        .leftJoinAndSelect("st.splits", "splits")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
        .leftJoinAndSelect("splits.tags", "splitTags")
        .leftJoinAndSelect(
          "splits.investmentSecurity",
          "splitInvestmentSecurity",
        )
        .where("st.userId = :userId", { userId })
        .andWhere("st.isActive = :isActive", { isActive: true })
        .andWhere("st.nextDueDate <= :futureDate", { futureDate })
        .orderBy("st.nextDueDate", "ASC")
        .getMany(),
    );
  }

  /**
   * Curated upcoming bills/deposits payload for AI Assistant and MCP. Both
   * surfaces must return the same shape; the executor and MCP tool are thin
   * adapters around this method.
   *
   * Items are classified by `kind` (bill / deposit / transfer / investment)
   * so the LLM can answer "what bills are due" or "what deposits are coming
   * in" without re-deriving sign or transfer/investment flags.
   */
  async getLlmUpcomingBillsAndDeposits(
    userId: string,
    filter: LlmUpcomingFilter = {},
  ): Promise<LlmUpcomingScheduledResult> {
    const days = filter.days ?? 30;
    const today = todayYMD();
    // The *occurrence* that is next due, not the schedule's template: an
    // occurrence the user re-priced or moved is what will actually post, so
    // reporting the base amount here made the assistant and MCP disagree with
    // the register about a bill the user had already changed (issue #1247).
    // `maxOccurrences: 1` keeps this payload one row per schedule, which is the
    // shape both tool layers publish.
    const occurrences = await this.occurrences.findOccurrences(userId, {
      through: addDaysYMD(today, days),
      maxOccurrences: 1,
    });
    // Everything the window holds that the caller's OTHER filters accept. The
    // rollups are built from this rather than from the kind-filtered list,
    // because an occurrence whose direction is not derivable is exactly what a
    // `kind: "bill"` filter must not be allowed to hide: dropping it first
    // returned a complete-looking `totalUpcomingBills` with
    // `amountsComplete: true`, which is what the tool descriptions promise never
    // happens (issue #1247 re-audit).
    const rollupBase = occurrences
      .map((occurrence) => toLlmScheduledItem(occurrence, today))
      .filter((item) =>
        matchesScheduledFilter(item, { ...filter, kind: undefined }),
      );
    const items = rollupBase.filter((item) =>
      matchesScheduledFilter(item, filter),
    );

    // From the ROLLUP BASE, not from the kind-filtered list.
    //
    // A rollup total is a statement about the window, and a caller narrowing the
    // LIST to deposits has not said the bills stopped existing. Taken from
    // `items`, `kind: "deposit"` made `bills` empty and published
    // `totalUpcomingBills: 0` with `amountsComplete: true` -- a confident "no
    // bills are coming" over a window holding a 1,200 bill. That is the same
    // defect the `unclassified` line below already guards against, and the
    // previous pass fixed only that half of it: the unknown bucket was moved off
    // the filtered list while these two were left on it (issue #1247, round 4).
    const bills = rollupBase.filter((i) => i.kind === "bill");
    const deposits = rollupBase.filter((i) => i.kind === "deposit");
    // An occurrence whose direction is not derivable could belong to EITHER
    // bucket, so it withholds both totals rather than being quietly left out of
    // both -- its amount is null, which is what `totalConvertedInto` withholds
    // on. It stays out of the two item lists, because a list of bills that
    // includes something that might be a deposit is a worse answer than a named
    // unknown (issue #1247 re-audit).
    const unclassified = rollupBase.filter((i) => i.kind === "unknown");
    // A bucket's total exists only when every item in it resolved AND every one
    // of them converted into the currency the total is reported in; the partial
    // sum travels in its own explicitly-named field so nothing reads it as a
    // total. Each bucket otherwise answers for itself -- an unknown deposit does
    // not make the bills total unknowable.
    //
    // An item's `currency` is its SETTLEMENT currency, which for an investment
    // schedule is neither the brokerage account's nor the reader's: summing the
    // raw numbers published a 1,350 CAD occurrence beside a 500 USD bill as a
    // confident `1850` under one label, which is the exact figure both tool
    // descriptions promise cannot appear (issue #1247 re-audit).
    const totalsCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    // One cache across BOTH buckets: an unclassified occurrence is in each of
    // them, so a per-bucket cache would ask for its pair twice.
    const rateFor = memoizedRateResolver(
      this.exchangeRateService,
      totalsCurrency,
      today,
    );
    const billsTotal = await convertingTotal(
      [...bills, ...unclassified],
      totalsCurrency,
      rateFor,
      (a) => Math.abs(a),
    );
    const depositsTotal = await convertingTotal(
      [...deposits, ...unclassified],
      totalsCurrency,
      rateFor,
    );
    const missingRatePairs = [
      ...new Set([...billsTotal.missingPairs, ...depositsTotal.missingPairs]),
    ].sort();
    // Named from the rollup base, which is what the totals now cover: an item
    // the kind filter removed from the LIST still makes a total incomplete, so
    // the caller has to be told which item it was. Reading `items` here named
    // only the ones that survived the filter, so an unpriceable bill under
    // `kind: "deposit"` went unmentioned while making the bills total unknown.
    const unknownAmountItems = [
      ...new Set(
        rollupBase.filter((i) => !i.amountComplete).map((i) => i.name),
      ),
    ];

    return {
      daysWindow: days,
      itemCount: items.length,
      overdueCount: items.filter((i) => i.daysUntilDue < 0).length,
      totalUpcomingBills: billsTotal.total,
      totalUpcomingDeposits: depositsTotal.total,
      totalsCurrency,
      ...(billsTotal.total === null
        ? { knownUpcomingBillsSubtotal: billsTotal.knownSubtotal }
        : {}),
      ...(depositsTotal.total === null
        ? { knownUpcomingDepositsSubtotal: depositsTotal.knownSubtotal }
        : {}),
      // A withheld total has two causes and the reader needs to know which:
      // an item whose own amount could not be worked out (named here) and an
      // item in a currency with no rate into the reporting one (named below).
      // Reporting the second as the first sends the reader to the schedule
      // instead of to the rate.
      amountsComplete:
        unknownAmountItems.length === 0 && missingRatePairs.length === 0,
      ...(unknownAmountItems.length > 0 ? { unknownAmountItems } : {}),
      ...(missingRatePairs.length > 0 ? { missingRatePairs } : {}),
      items,
    };
  }

  /**
   * The occurrences due through `through`, priced at what each would post today
   * (issue #1247).
   *
   * This is what a client renders a bills calendar, list or export from. It
   * exists because the browser cannot answer the question: expanding the
   * recurrence client-side gives you dates but no per-occurrence amount, so the
   * Upcoming Bills report applied one schedule-level figure to every projected
   * occurrence and exported it -- wrong for every occurrence the user had
   * re-priced, and wrong by the FX drift for an investment schedule.
   *
   * `accountId` / `transferAccountId` / `isTransfer` travel with each occurrence
   * so the delegate filter and the transfer mask can do their work on this
   * payload exactly as they do on a schedule list.
   */
  async findEffectiveOccurrences(
    userId: string,
    options: { through: string; maxPerSchedule?: number },
  ): Promise<ScheduledOccurrenceReadModel[]> {
    const occurrences = await this.occurrences.findOccurrences(userId, {
      through: options.through,
      maxOccurrences: options.maxPerSchedule ?? 100,
    });
    return occurrences.map((occurrence) => ({
      scheduledTransactionId: occurrence.scheduledTransactionId,
      originalDate: occurrence.originalDate,
      dueDate: occurrence.dueDate,
      amount: occurrence.amount,
      amountComplete: occurrence.complete,
      directionAmount: occurrence.directionAmount,
      currencyCode: occurrence.currencyCode,
      overrideId: occurrence.overrideId,
      moved: occurrence.moved,
      accountId: occurrence.schedule.accountId,
      transferAccountId: occurrence.schedule.transferAccountId ?? null,
      isTransfer: !!occurrence.schedule.isTransfer,
    }));
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);
    const beforeData = { ...scheduled };

    const effectiveIsInvestment =
      updateDto.isInvestment !== undefined
        ? updateDto.isInvestment
        : scheduled.isInvestment;
    const effectiveIsTransfer =
      updateDto.isTransfer !== undefined
        ? updateDto.isTransfer
        : scheduled.isTransfer;
    if (effectiveIsInvestment && effectiveIsTransfer) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.notTransferAndInvestment",
          "A scheduled transaction cannot be both a transfer and an investment",
        ),
      );
    }

    let accountCurrencyCode = scheduled.currencyCode;
    if (updateDto.accountId && updateDto.accountId !== scheduled.accountId) {
      const nextAccount = await this.accountsService.findOne(
        userId,
        updateDto.accountId,
      );
      accountCurrencyCode = nextAccount.currencyCode;
    }

    if (updateDto.isTransfer && updateDto.transferAccountId) {
      await this.accountsService.findOne(userId, updateDto.transferAccountId);
      const accountId = updateDto.accountId || scheduled.accountId;
      if (updateDto.transferAccountId === accountId) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.sameSourceAndDestination",
            "Source and destination accounts must be different",
          ),
        );
      }
    }

    if (effectiveIsInvestment) {
      const accountId = updateDto.accountId || scheduled.accountId;
      const account = await this.accountsService.findOne(userId, accountId);
      if (account.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.requiresBrokerageAccount",
            "Scheduled investment transactions require a brokerage account",
          ),
        );
      }
      // Validate the values that will actually be written. `suppliedOrStored`
      // keeps an explicit null distinct from an omitted key, so a
      // `{ investmentTotalAmount: null }` PATCH is validated as null (and
      // rejected for an amount-only action) rather than passing against the
      // stored value and then persisting the null (issue #1154 review).
      const merged = {
        investmentAction: suppliedOrStored(
          updateDto.investmentAction as InvestmentAction | null | undefined,
          scheduled.investmentAction as InvestmentAction | null,
        ),
        investmentSecurityId: suppliedOrStored(
          updateDto.investmentSecurityId as string | null | undefined,
          scheduled.investmentSecurityId,
        ),
        investmentQuantity: suppliedOrStored(
          updateDto.investmentQuantity as number | null | undefined,
          scheduled.investmentQuantity,
        ),
        investmentPrice: suppliedOrStored(
          updateDto.investmentPrice as number | null | undefined,
          scheduled.investmentPrice,
        ),
        investmentTotalAmount: suppliedOrStored(
          updateDto.investmentTotalAmount as number | null | undefined,
          scheduled.investmentTotalAmount,
        ),
        investmentExchangeRate: suppliedOrStored(
          updateDto.investmentExchangeRate as number | null | undefined,
          scheduled.investmentExchangeRate,
        ),
      };
      this.validateInvestmentFields(merged);
      // Only validate a funding account that will actually be used: a stale one
      // on a non-BUY/SELL action is cleared below, so it need not resolve.
      const effectiveFundingAccountId = suppliedOrStored(
        updateDto.investmentFundingAccountId as string | null | undefined,
        scheduled.investmentFundingAccountId,
      );
      if (
        merged.investmentAction &&
        FUNDING_ACCOUNT_ACTIONS.has(merged.investmentAction) &&
        effectiveFundingAccountId
      ) {
        await this.accountsService.findOne(userId, effectiveFundingAccountId);
      }
    }

    const {
      splits,
      isTransfer,
      transferAccountId,
      isInvestment,
      ...updateData
    } = updateDto;

    // Validate splits before opening the transaction so user errors fail fast
    // without holding a connection.
    if (splits !== undefined && Array.isArray(splits) && splits.length > 0) {
      const amount = updateData.amount ?? scheduled.amount;
      this.validateSplits(splits, amount);
    }

    const fieldsToUpdate: Record<string, any> = {};
    // Set when switching to transfer/investment mode, which clears any splits.
    let clearSplitsForModeSwitch = false;

    if (updateData.accountId !== undefined)
      fieldsToUpdate.accountId = updateData.accountId;
    if (updateData.name !== undefined) fieldsToUpdate.name = updateData.name;
    if (updateData.payeeId !== undefined)
      fieldsToUpdate.payeeId = updateData.payeeId || null;
    if (updateData.payeeName !== undefined)
      fieldsToUpdate.payeeName = updateData.payeeName || null;
    if (updateData.categoryId !== undefined)
      fieldsToUpdate.categoryId = updateData.categoryId || null;
    if (updateData.amount !== undefined)
      fieldsToUpdate.amount = updateData.amount;
    if (updateData.currencyCode !== undefined)
      fieldsToUpdate.currencyCode = updateData.currencyCode;

    // Foreign-currency entry. Only a plain schedule can carry one, so switching
    // an existing foreign-currency schedule to split/transfer/investment clears
    // the trio rather than leaving an amount nothing re-derives.
    const effectiveIsSplit =
      splits !== undefined
        ? Array.isArray(splits) && splits.length > 0 && !effectiveIsTransfer
        : scheduled.isSplit;
    const fxKind = {
      isSplit: effectiveIsSplit,
      isTransfer: effectiveIsTransfer,
      isInvestment: effectiveIsInvestment,
    };

    if (effectiveIsSplit || effectiveIsTransfer || effectiveIsInvestment) {
      // Throws when the payload actually supplied a foreign entry.
      this.resolveScheduleFx(updateData, accountCurrencyCode, fxKind);
      if (scheduled.originalCurrencyCode) {
        fieldsToUpdate.originalAmount = null;
        fieldsToUpdate.originalCurrencyCode = null;
        fieldsToUpdate.exchangeRate = 1;
      }
    } else if (
      updateData.originalAmount !== undefined ||
      updateData.originalCurrencyCode !== undefined ||
      updateData.exchangeRate !== undefined
    ) {
      const fx = this.resolveScheduleFx(
        {
          amount: updateData.amount ?? Number(scheduled.amount),
          originalAmount:
            updateData.originalAmount !== undefined
              ? updateData.originalAmount
              : scheduled.originalAmount,
          originalCurrencyCode:
            updateData.originalCurrencyCode !== undefined
              ? updateData.originalCurrencyCode
              : scheduled.originalCurrencyCode,
          exchangeRate:
            updateData.exchangeRate !== undefined
              ? updateData.exchangeRate
              : scheduled.exchangeRate,
        },
        accountCurrencyCode,
        fxKind,
      );
      fieldsToUpdate.originalAmount = fx.originalAmount;
      fieldsToUpdate.originalCurrencyCode = fx.originalCurrencyCode;
      fieldsToUpdate.exchangeRate = fx.exchangeRate;
    }
    if (updateData.description !== undefined)
      fieldsToUpdate.description = updateData.description || null;
    if (updateData.frequency !== undefined)
      fieldsToUpdate.frequency = updateData.frequency;
    if (updateData.nextDueDate !== undefined)
      fieldsToUpdate.nextDueDate = updateData.nextDueDate;
    if (updateData.startDate !== undefined)
      fieldsToUpdate.startDate = updateData.startDate;
    if (updateData.endDate !== undefined)
      fieldsToUpdate.endDate = updateData.endDate || null;
    if (updateData.occurrencesRemaining !== undefined)
      fieldsToUpdate.occurrencesRemaining =
        updateData.occurrencesRemaining ?? null;
    if (updateData.isActive !== undefined)
      fieldsToUpdate.isActive = updateData.isActive;
    if (updateData.autoPost !== undefined)
      fieldsToUpdate.autoPost = updateData.autoPost;
    if (updateData.reminderDaysBefore !== undefined)
      fieldsToUpdate.reminderDaysBefore = updateData.reminderDaysBefore;
    if (updateData.tagIds !== undefined)
      fieldsToUpdate.tagIds = updateData.tagIds;

    if (isTransfer !== undefined) {
      fieldsToUpdate.isTransfer = isTransfer;
      if (isTransfer) {
        fieldsToUpdate.isSplit = false;
        // Keep categoryId: a transfer may carry an optional category (#743). It
        // is controlled by updateData.categoryId above, not cleared here.
        fieldsToUpdate.isInvestment = false;
        fieldsToUpdate.investmentAction = null;
        fieldsToUpdate.investmentSecurityId = null;
        fieldsToUpdate.investmentFundingAccountId = null;
        fieldsToUpdate.investmentQuantity = null;
        fieldsToUpdate.investmentPrice = null;
        fieldsToUpdate.investmentCommission = null;
        fieldsToUpdate.investmentTotalAmount = null;
        fieldsToUpdate.investmentExchangeRate = null;
        // The rate's currency pair travels with the rate (issue #1167).
        fieldsToUpdate.investmentExchangeRateFromCurrency = null;
        fieldsToUpdate.investmentExchangeRateToCurrency = null;
        clearSplitsForModeSwitch = true;
      }
    }
    if (transferAccountId !== undefined) {
      fieldsToUpdate.transferAccountId = transferAccountId || null;
    }

    if (isInvestment !== undefined) {
      fieldsToUpdate.isInvestment = isInvestment;
      if (isInvestment) {
        fieldsToUpdate.isSplit = false;
        fieldsToUpdate.isTransfer = false;
        fieldsToUpdate.categoryId = null;
        fieldsToUpdate.transferAccountId = null;
        clearSplitsForModeSwitch = true;
      } else {
        fieldsToUpdate.investmentAction = null;
        fieldsToUpdate.investmentSecurityId = null;
        fieldsToUpdate.investmentFundingAccountId = null;
        fieldsToUpdate.investmentQuantity = null;
        fieldsToUpdate.investmentPrice = null;
        fieldsToUpdate.investmentCommission = null;
        fieldsToUpdate.investmentTotalAmount = null;
        fieldsToUpdate.investmentExchangeRate = null;
        // The rate's currency pair travels with the rate (issue #1167).
        fieldsToUpdate.investmentExchangeRateFromCurrency = null;
        fieldsToUpdate.investmentExchangeRateToCurrency = null;
      }
    }
    if (effectiveIsInvestment) {
      if (updateData.investmentAction !== undefined)
        fieldsToUpdate.investmentAction = updateData.investmentAction;
      if (updateData.investmentSecurityId !== undefined)
        fieldsToUpdate.investmentSecurityId =
          updateData.investmentSecurityId || null;
      if (updateData.investmentFundingAccountId !== undefined)
        fieldsToUpdate.investmentFundingAccountId =
          updateData.investmentFundingAccountId || null;
      if (updateData.investmentQuantity !== undefined)
        fieldsToUpdate.investmentQuantity =
          updateData.investmentQuantity ?? null;
      if (updateData.investmentPrice !== undefined)
        fieldsToUpdate.investmentPrice = updateData.investmentPrice ?? null;
      if (updateData.investmentCommission !== undefined)
        fieldsToUpdate.investmentCommission =
          updateData.investmentCommission ?? null;
      if (updateData.investmentTotalAmount !== undefined)
        fieldsToUpdate.investmentTotalAmount =
          updateData.investmentTotalAmount ?? null;
      if (updateData.investmentExchangeRate !== undefined)
        fieldsToUpdate.investmentExchangeRate =
          updateData.investmentExchangeRate ?? null;

      // Editing an investment away from BUY/SELL must drop any funding account
      // the row was carrying, even when the client omits the key rather than
      // sending an explicit null (issue #1154). The effective action is the one
      // being written, or the stored one when the edit leaves it untouched.
      const effectiveInvestmentAction = (updateData.investmentAction ??
        scheduled.investmentAction) as InvestmentAction | null;
      if (
        !effectiveInvestmentAction ||
        !FUNDING_ACCOUNT_ACTIONS.has(effectiveInvestmentAction)
      ) {
        fieldsToUpdate.investmentFundingAccountId = null;
      }

      // The same omit-doesn't-clear defect applies to the numeric fields the
      // issue calls out (issue #1154): switching action leaves quantity/price/
      // commission/total from the old action on the row. This is not a money
      // bug -- postInvestment reads only the fields its effective action uses --
      // but it leaves the row internally inconsistent, so clear each field the
      // effective action does not use. The clear is safe: validateInvestmentFields
      // (run above) guarantees the action's required field is present, and the
      // fields dropped here are exactly the ones postInvestment ignores for that
      // action, so no posted amount changes. Unlike investmentExchangeRate (see
      // postInvestment), none of these carries a value that is legitimate under
      // more than one action, so an action-keyed clear cannot over-clear.
      const usesQuantity =
        !!effectiveInvestmentAction &&
        (QUANTITY_PRICE_ACTIONS.has(effectiveInvestmentAction) ||
          QUANTITY_ONLY_ACTIONS.has(effectiveInvestmentAction));
      const usesPrice =
        !!effectiveInvestmentAction &&
        QUANTITY_PRICE_ACTIONS.has(effectiveInvestmentAction);
      const usesTotalAmount =
        !!effectiveInvestmentAction &&
        AMOUNT_ONLY_ACTIONS.has(effectiveInvestmentAction);
      if (!usesQuantity) fieldsToUpdate.investmentQuantity = null;
      if (!usesPrice) {
        fieldsToUpdate.investmentPrice = null;
        fieldsToUpdate.investmentCommission = null;
      }
      if (!usesTotalAmount) fieldsToUpdate.investmentTotalAmount = null;

      const actionChanged =
        updateData.investmentAction !== undefined &&
        updateData.investmentAction !== scheduled.investmentAction;

      // The scheduled UI has no security field for INTEREST, so switching to it
      // must not keep the previous action's security -- the cash-settlement
      // currency is derived from the security, so a stale one converts the
      // interest in the wrong currency (issue #1154 review). Clear it only on
      // the transition and only when the caller did not explicitly supply one,
      // leaving a deliberate API value for a future product decision.
      if (
        actionChanged &&
        effectiveInvestmentAction === InvestmentAction.INTEREST &&
        updateData.investmentSecurityId === undefined
      ) {
        fieldsToUpdate.investmentSecurityId = null;
      }

      // A stored exchange rate describes a settlement tuple (account + security
      // + cash destination), not just an action, and the column does not record
      // the currency pair it was resolved for. If any part of that tuple changes
      // and no replacement rate is supplied, force post-time re-resolution
      // rather than applying a rate for the old pair (issue #1154 review). This
      // is the value-difference guard the earlier deferral asked for -- a
      // presentation-only edit (e.g. the name) does not touch the tuple, so a
      // legitimate cross-currency dividend rate is preserved.
      const effectiveSecurityIdForFx =
        fieldsToUpdate.investmentSecurityId !== undefined
          ? (fieldsToUpdate.investmentSecurityId as string | null)
          : suppliedOrStored(
              updateData.investmentSecurityId as string | null | undefined,
              scheduled.investmentSecurityId,
            );
      const effectiveFundingForFx =
        effectiveInvestmentAction &&
        FUNDING_ACCOUNT_ACTIONS.has(effectiveInvestmentAction)
          ? suppliedOrStored(
              updateData.investmentFundingAccountId as
                string | null | undefined,
              scheduled.investmentFundingAccountId,
            )
          : null;
      const storedFundingForFx =
        scheduled.investmentAction &&
        FUNDING_ACCOUNT_ACTIONS.has(
          scheduled.investmentAction as InvestmentAction,
        )
          ? scheduled.investmentFundingAccountId
          : null;
      const settlementBasisChanged =
        (updateData.accountId !== undefined &&
          updateData.accountId !== scheduled.accountId) ||
        effectiveSecurityIdForFx !== scheduled.investmentSecurityId ||
        effectiveFundingForFx !== storedFundingForFx;
      if (
        settlementBasisChanged &&
        updateData.investmentExchangeRate === undefined
      ) {
        fieldsToUpdate.investmentExchangeRate = null;
      }

      // Keep the rate's currency-pair provenance in lockstep with the rate
      // itself (issue #1167), and stamp a *fresh* pair only for a *fresh* rate.
      // The scheduled form resends the stored scalar on every save, so a field
      // being present is not the same as its value changing -- restamping the
      // current pair onto an unchanged scalar would relabel a since-stale rate
      // as belonging to the new pair and destroy the evidence that made it
      // detectable as stale (issue #1167 review). So:
      //   - rate cleared  -> clear the pair;
      //   - rate unchanged -> preserve the stored pair (a since-changed currency
      //     is then still caught at posting, because the old pair no longer
      //     matches the current one);
      //   - rate genuinely changed -> it was just resolved for the current pair,
      //     so record the current pair.
      if (fieldsToUpdate.investmentExchangeRate !== undefined) {
        const writtenRate = fieldsToUpdate.investmentExchangeRate as
          number | null;
        const rateUnchanged =
          writtenRate !== null &&
          scheduled.investmentExchangeRate !== null &&
          scheduled.investmentExchangeRate !== undefined &&
          Number(writtenRate) === Number(scheduled.investmentExchangeRate);
        if (writtenRate === null) {
          fieldsToUpdate.investmentExchangeRateFromCurrency = null;
          fieldsToUpdate.investmentExchangeRateToCurrency = null;
        } else if (rateUnchanged && !updateDto.investmentExchangeRateExplicit) {
          fieldsToUpdate.investmentExchangeRateFromCurrency =
            scheduled.investmentExchangeRateFromCurrency ?? null;
          fieldsToUpdate.investmentExchangeRateToCurrency =
            scheduled.investmentExchangeRateToCurrency ?? null;
        } else {
          // A genuinely changed rate, or one the user explicitly re-entered for
          // the current pair (`investmentExchangeRateExplicit`, R11-F1) even when
          // its value equals the stored one, was just resolved for the current
          // pair -- so record the current pair.
          const provenance =
            await this.effectiveAmounts.resolveInvestmentRateProvenance(
              userId,
              writtenRate,
              {
                accountId: updateData.accountId ?? scheduled.accountId,
                fundingAccountId: effectiveFundingForFx,
                securityId: effectiveSecurityIdForFx,
              },
            );
          fieldsToUpdate.investmentExchangeRateFromCurrency = provenance.from;
          fieldsToUpdate.investmentExchangeRateToCurrency = provenance.to;
        }
      }
    }

    // Apply the split rewrite, any mode-switch split clearing, and the main
    // row update atomically so a partial failure cannot leave the row and its
    // splits in an inconsistent state.
    await withScopedDb(this.dataSource, async (m) => {
      // The effective action, validation and the action-dependent clears above
      // were derived from `scheduled`, read before this transaction. Re-read the
      // row under the lock and refuse if the mutation basis changed in between:
      // otherwise a concurrent action switch that committed first would be
      // overwritten by this request's stale derived clears (e.g. nulling the
      // quantity/price a concurrent BUY just set) (issue #1154 review).
      const current = await m.findOne(ScheduledTransaction, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!current) {
        throw new NotFoundException(
          tr(
            "errors.scheduled.notFound",
            `Scheduled transaction with ID ${id} not found`,
            { id },
          ),
        );
      }
      if (!sameScheduleMutationBasis(scheduled, current)) {
        throw new ConflictException(
          tr(
            "errors.scheduled.changedConcurrently",
            "The scheduled transaction changed during the operation. Reload it and retry.",
          ),
        );
      }

      if (splits !== undefined) {
        if (Array.isArray(splits) && splits.length > 0) {
          // Capture the existing splits' recorded pairs before deleting them, so
          // a resent-unchanged rate keeps its provenance rather than being
          // relabelled with the current pair (issue #1167 re-review). Correlated
          // by stable split id (F4) with a value-key fallback, so two splits for
          // one security cannot swap provenance when one's rate changes to the
          // other's old value.
          const oldSplits = await m.find(ScheduledTransactionSplit, {
            where: { scheduledTransactionId: id },
          });
          const oldProvenanceBySecurityId =
            this.buildSplitProvenanceSource(oldSplits);
          await m.delete(ScheduledTransactionSplit, {
            scheduledTransactionId: id,
          });
          await this.createSplits(
            id,
            splits,
            m,
            userId,
            updateData.accountId ?? current.accountId,
            oldProvenanceBySecurityId,
          );
          await m.update(ScheduledTransaction, id, {
            isSplit: true,
            categoryId: null,
          });
        } else if (Array.isArray(splits) && splits.length === 0) {
          await m.delete(ScheduledTransactionSplit, {
            scheduledTransactionId: id,
          });
          await m.update(ScheduledTransaction, id, {
            isSplit: false,
          });
        }
      }

      if (clearSplitsForModeSwitch) {
        await m.delete(ScheduledTransactionSplit, {
          scheduledTransactionId: id,
        });
      }

      if (Object.keys(fieldsToUpdate).length > 0) {
        await m.update(ScheduledTransaction, id, fieldsToUpdate);
      }

      // A user edit of a loan payment schedule is a reconfiguration, so it has
      // to reach the durable copy on the account: the per-posting
      // recalculation grows the template back toward
      // payment_amount / extra_payment_amount, because the template itself
      // also carries transient clamps a previous pass wrote (a final payment,
      // an interest spike) and cannot say which of the two it holds (review
      // #1131).
      if (
        updateData.amount !== undefined ||
        splits !== undefined ||
        clearSplitsForModeSwitch
      ) {
        const loanAccount = await m.getRepository(Account).findOne({
          where: { scheduledTransactionId: id, userId },
        });
        if (loanAccount) {
          const accountUpdate: Partial<Account> = {};
          // A LINEAR or INTEREST_ONLY mortgage has no constant payment to
          // record (spec decision 11; the column's CHECK refuses one): the
          // edit stands for the template only, and the next advancement
          // reprices it to the method's installment.
          if (
            updateData.amount !== undefined &&
            !(
              loanAccount.accountType === AccountType.MORTGAGE &&
              !storesConstantPayment(mortgageTypeOf(loanAccount))
            )
          ) {
            accountUpdate.paymentAmount = Math.abs(Number(updateData.amount));
          }
          if (Array.isArray(splits)) {
            const extraSplit = splits.find(
              (s) =>
                s.transferAccountId === loanAccount.id &&
                s.memo?.toLowerCase().includes("extra"),
            );
            accountUpdate.extraPaymentAmount = extraSplit
              ? Math.abs(Number(extraSplit.amount))
              : 0;
          } else if (clearSplitsForModeSwitch) {
            accountUpdate.extraPaymentAmount = 0;
          }
          if (Object.keys(accountUpdate).length > 0) {
            await m
              .getRepository(Account)
              .update(loanAccount.id, accountUpdate);
          }
        }
      }
    });

    const result = await this.findOne(userId, id);

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_transaction",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...result },
      description: `Updated scheduled transaction "${result.name}"`,
      descriptionKey: "updatedScheduledTransaction",
      descriptionParams: { name: result.name },
    });

    return result;
  }

  async remove(userId: string, id: string): Promise<void> {
    const scheduled = await this.findOne(userId, id);
    const beforeData = { ...scheduled };
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransaction).remove(scheduled),
    );

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_transaction",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted scheduled transaction "${beforeData.name}"`,
      descriptionKey: "deletedScheduledTransaction",
      descriptionParams: { name: beforeData.name },
    });
  }

  async skip(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    const nextDueDateStr = ensureYMD(scheduled.nextDueDate);

    const newNextDueDateStr = calcNextDueDate(
      nextDueDateStr,
      scheduled.frequency,
    );

    const updateFields: Record<string, any> = {
      nextDueDate: newNextDueDateStr,
    };

    if (
      scheduled.occurrencesRemaining !== null &&
      scheduled.occurrencesRemaining > 0
    ) {
      const newRemaining = scheduled.occurrencesRemaining - 1;
      updateFields.occurrencesRemaining = newRemaining;
      if (newRemaining === 0) {
        updateFields.isActive = false;
      }
    }

    if (scheduled.endDate && newNextDueDateStr > ensureYMD(scheduled.endDate)) {
      updateFields.isActive = false;
    }

    await withScopedDb(this.dataSource, async (m) => {
      await m.getRepository(ScheduledTransactionOverride).delete({
        scheduledTransactionId: id,
        originalDate: nextDueDateStr,
      });
      await m.getRepository(ScheduledTransaction).update(id, updateFields);
    });
    return this.findOne(userId, id);
  }

  /**
   * Work out the foreign amount, rate and account-currency total for one
   * posting of a foreign-currency schedule. Returns null for an ordinary
   * schedule, leaving the existing amount precedence untouched.
   *
   * Precedence, highest first:
   *   1. `postDto.amount`, else the occurrence override's amount -- both are
   *      account-currency totals. An override deliberately stays in the account
   *      currency (it means "this month the bank actually took $X"), which is
   *      also what every reader of `override.amount` already assumes: the bills
   *      list, the forecast, the budget and dashboard widgets. The fee is
   *      backed out and the rate derived from the base so the posted row still
   *      round-trips (originalAmount x exchangeRate ~ base).
   *   2. `postDto.exchangeRate` -- an explicit rate for this posting.
   *   3. The stored rate for the posting date (`getRateForDate`, which
   *      carry-forwards over weekends and backfills from the quote provider).
   *
   * The foreign amount comes from `postDto.originalAmount`, else the schedule's
   * own `originalAmount`.
   */
  private async resolveFxForPosting(
    scheduled: ScheduledTransaction,
    postDto: PostScheduledTransactionDto | undefined,
    context: { postDate: string; overrideAmount: number | null },
  ): Promise<{
    originalAmount: number;
    exchangeRate: number;
    amount: number;
  } | null> {
    if (!scheduled.originalCurrencyCode || scheduled.originalAmount === null) {
      return null;
    }

    const originalAmount =
      postDto?.originalAmount !== undefined && postDto?.originalAmount !== null
        ? Number(postDto.originalAmount)
        : Number(scheduled.originalAmount);

    const fxFeePercent = scheduled.account?.fxFeePercent ?? null;

    // 1. An explicit account-currency total wins; derive the rate from it.
    const pinnedTotal =
      postDto?.amount !== undefined && postDto?.amount !== null
        ? Number(postDto.amount)
        : context.overrideAmount !== null
          ? Number(context.overrideAmount)
          : null;
    if (pinnedTotal !== null) {
      let base = pinnedTotal;
      if (fxFeePercent && fxFeePercent > 0) {
        // total = base - |base| x p; solve for base by its (matching) sign.
        const p = fxFeePercent / 100;
        base = roundMoney(
          pinnedTotal >= 0 ? pinnedTotal / (1 - p) : pinnedTotal / (1 + p),
        );
      }
      return {
        originalAmount,
        exchangeRate:
          originalAmount === 0 ? 1 : roundFxRate(base / originalAmount),
        amount: roundMoney(pinnedTotal),
      };
    }

    // 2/3. An explicit rate, else the rate that applied on the posting date.
    const rate =
      postDto?.exchangeRate !== undefined && postDto?.exchangeRate !== null
        ? Number(postDto.exchangeRate)
        : await this.exchangeRateService.getRateForDate(
            scheduled.originalCurrencyCode,
            scheduled.currencyCode,
            context.postDate,
          );

    if (rate === null || !isFinite(rate) || rate <= 0) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.fxRateUnavailable",
          `No exchange rate is available for ${scheduled.originalCurrencyCode} to ${scheduled.currencyCode} on ${context.postDate}. Enter the amount in ${scheduled.currencyCode} to post it.`,
          {
            from: scheduled.originalCurrencyCode,
            to: scheduled.currencyCode,
            date: context.postDate,
          },
        ),
      );
    }

    const converted = applyFxConversion(originalAmount, rate, fxFeePercent);
    return {
      originalAmount,
      exchangeRate: roundFxRate(rate),
      amount: converted.amount,
    };
  }

  async post(
    userId: string,
    id: string,
    postDto?: PostScheduledTransactionDto,
    options: {
      requireActiveAutoPost?: boolean;
      /**
       * The occurrence the caller selected. When set, the post refuses with
       * `ConflictException` unless it is still the due one, instead of posting
       * whatever the schedule's `next_due_date` has advanced to since.
       */
      expectedDueDate?: string;
      /**
       * The poster is a delegate acting as the owner (see
       * `TransactionsService.create`): the owner's structural rules are
       * skipped on the posted row. Set from the verified identity only.
       */
      actorIsNotOwner?: boolean;
    } = {},
  ): Promise<ScheduledTransaction | null> {
    const scheduled = await this.findOne(userId, id);

    const nextDueDateStr = ensureYMD(scheduled.nextDueDate);

    // The auto-post cron selects a due occurrence, then posts it. Without this,
    // a replica whose selection went stale -- another replica posted the
    // occurrence and advanced `next_due_date` in between -- re-read the row
    // above and posted the NEXT, not-yet-due occurrence: a fresh claim key, so
    // neither the claim nor the lock stopped it, and every extra replica
    // posted the bill once more (issue #1452). Refusing here keeps the loser
    // off the FX lookup; the under-lock check against `nextDueDateStr` below
    // is what holds it inside the posting transaction.
    if (
      options.expectedDueDate !== undefined &&
      nextDueDateStr !== ensureYMD(options.expectedDueDate)
    ) {
      throw new ConflictException(
        tr(
          "errors.scheduled.occurrenceAlreadyPosted",
          "This occurrence has already been posted.",
        ),
      );
    }

    const storedOverride = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("override")
        .where("override.scheduledTransactionId = :id", { id })
        .andWhere("override.originalDate = :nextDueDateStr", { nextDueDateStr })
        .getOne(),
    );

    const postDate =
      postDto?.transactionDate ||
      storedOverride?.overrideDate ||
      nextDueDateStr;

    const hasInlineAmount =
      postDto?.amount !== undefined && postDto?.amount !== null;
    const hasInlineCategoryId = postDto?.categoryId !== undefined;
    const hasInlineDescription = postDto?.description !== undefined;
    const hasInlineIsSplit =
      postDto?.isSplit !== undefined && postDto?.isSplit !== null;
    const hasInlineSplits = postDto?.splits && postDto.splits.length > 0;

    // A foreign-currency schedule holds its fixed amount in the entry currency,
    // so every per-occurrence amount -- the schedule's own, a stored override,
    // an inline `originalAmount` -- is read in that currency and converted at
    // the rate for the posting date. That is what makes a back-dated or
    // future-dated posting use that day's rate rather than the estimate the
    // bills list was showing.
    const fx = await this.resolveFxForPosting(scheduled, postDto, {
      postDate,
      overrideAmount: storedOverride?.amount ?? null,
    });

    const finalAmount = fx
      ? fx.amount
      : hasInlineAmount
        ? Number(postDto.amount)
        : storedOverride?.amount !== null &&
            storedOverride?.amount !== undefined
          ? Number(storedOverride.amount)
          : Number(scheduled.amount);

    const finalDescription = hasInlineDescription
      ? postDto.description
      : storedOverride?.description !== null &&
          storedOverride?.description !== undefined
        ? storedOverride.description
        : scheduled.description || undefined;

    const transactionPayload: any = {
      accountId: scheduled.accountId,
      transactionDate: postDate,
      payeeId: scheduled.payeeId || undefined,
      payeeName: scheduled.payeeName || undefined,
      amount: finalAmount,
      currencyCode: scheduled.currencyCode,
      description: finalDescription,
      referenceNumber: postDto?.referenceNumber || undefined,
      isCleared: false,
      tagIds:
        scheduled.tagIds && scheduled.tagIds.length > 0
          ? scheduled.tagIds
          : undefined,
      ...(fx
        ? {
            originalAmount: fx.originalAmount,
            originalCurrencyCode: scheduled.originalCurrencyCode,
            exchangeRate: fx.exchangeRate,
          }
        : {}),
    };

    const useSplits = hasInlineIsSplit
      ? postDto.isSplit
      : storedOverride?.isSplit !== null &&
          storedOverride?.isSplit !== undefined
        ? storedOverride.isSplit
        : scheduled.isSplit;

    if (useSplits) {
      if (hasInlineSplits && postDto?.splits) {
        // Inline splits come from the client (the manual Post dialog resends the
        // scheduled/override splits verbatim). An investment line's stored FX
        // scalar must NOT be trusted just because it arrived as an explicit rate
        // -- that is the exact #1167 bypass (F5-1): the dialog round-trips the
        // persisted rate, and without re-resolution a since-changed pair commits
        // the stale figure. So each investment line is resolved through the same
        // effective-rate path as the stored surfaces: a rate whose recorded pair
        // still matches is reused, otherwise it is re-resolved for the current
        // pair. A line with no provenance is re-resolved, never trusted.
        //
        // The one case the echoed provenance cannot express is a rate the user
        // *edited* in the dialog (F2): its recorded pair is still the stale one, so
        // it would be re-resolved and the user's figure lost. Correlating each
        // inline line to its source split by id lets us tell an edited rate (its
        // value differs from the source's) from an unchanged echoed one, and honour
        // the edit against the current pair.
        const postSourceRate = new Map<string, number>();
        for (const s of scheduled.splits ?? []) {
          if (
            s.id &&
            s.investmentExchangeRate !== null &&
            s.investmentExchangeRate !== undefined
          ) {
            postSourceRate.set(s.id, Number(s.investmentExchangeRate));
          }
        }
        for (const s of storedOverride?.splits ?? []) {
          if (
            s.id &&
            s.investment?.exchangeRate !== null &&
            s.investment?.exchangeRate !== undefined
          ) {
            postSourceRate.set(s.id, Number(s.investment.exchangeRate));
          }
        }
        transactionPayload.splits = await Promise.all(
          postDto.splits.map(async (split) => {
            if (split.investment) {
              let fromCur = split.investment.exchangeRateFromCurrency;
              let toCur = split.investment.exchangeRateToCurrency;
              const incomingRate =
                split.investment.exchangeRate !== null &&
                split.investment.exchangeRate !== undefined
                  ? Number(split.investment.exchangeRate)
                  : null;
              const srcRate = split.sourceSplitId
                ? postSourceRate.get(split.sourceSplitId)
                : undefined;
              const userEdited =
                incomingRate !== null &&
                incomingRate > 0 &&
                // `rateExplicit` means the client asserts this rate is a deliberate
                // value for the current pair -- a new line, OR a continuing line
                // whose rate the user actually edited (incl. a same-value re-entry,
                // and a category->investment conversion). It is honoured regardless
                // of whether the row carries a sourceSplitId (issue #1167 R10-F2);
                // gating it on `!sourceSplitId` ignored the intent on exactly the
                // continuing rows that need it. A changed-from-source rate is also
                // fresh even when the client sent no explicit flag.
                (split.rateExplicit === true ||
                  (srcRate !== undefined && incomingRate !== srcRate));
              if (userEdited && split.investment.securityId) {
                // A rate the user changed from the source is a fresh rate for the
                // current settlement pair, so stamp that pair -- reused (honoured),
                // not re-resolved.
                const pair =
                  await this.investmentTransactionsService.resolveSettlementCurrencyPair(
                    userId,
                    scheduled.accountId,
                    null,
                    split.investment.securityId,
                  );
                fromCur = pair.from;
                toCur = pair.to;
              }
              const eff = await this.effectiveAmounts.resolveEffectiveSplitCash(
                userId,
                scheduled.accountId,
                split.investment.securityId,
                split.investment.action,
                Number(split.investment.quantity ?? 0),
                Number(split.investment.price ?? 0),
                Number(split.investment.commission ?? 0),
                split.investment.exchangeRate,
                fromCur,
                toCur,
                postDate,
              );
              return {
                splitKind: split.splitKind,
                categoryId: split.categoryId || undefined,
                transferAccountId: split.transferAccountId || undefined,
                investment: { ...split.investment, exchangeRate: eff.rate },
                amount: eff.amount,
                memo: split.memo || undefined,
              };
            }
            return {
              splitKind: split.splitKind,
              categoryId: split.categoryId || undefined,
              transferAccountId: split.transferAccountId || undefined,
              investment: split.investment,
              amount: Number(split.amount),
              memo: split.memo || undefined,
            };
          }),
        );
      } else if (storedOverride?.splits && storedOverride.splits.length > 0) {
        transactionPayload.splits = await Promise.all(
          storedOverride.splits.map(async (split: any) => {
            if (split.investment) {
              // Recompute the override split's effective rate AND cash amount so
              // a re-resolved rate never disagrees with a stale stored amount
              // (issue #1167).
              const eff = await this.effectiveAmounts.resolveEffectiveSplitCash(
                userId,
                scheduled.accountId,
                split.investment.securityId,
                split.investment.action,
                Number(split.investment.quantity ?? 0),
                Number(split.investment.price ?? 0),
                Number(split.investment.commission ?? 0),
                split.investment.exchangeRate,
                split.investment.exchangeRateFromCurrency,
                split.investment.exchangeRateToCurrency,
                postDate,
              );
              return {
                splitKind: split.splitKind,
                categoryId: split.categoryId || undefined,
                transferAccountId: split.transferAccountId || undefined,
                investment: { ...split.investment, exchangeRate: eff.rate },
                amount: eff.amount,
                memo: split.memo || undefined,
              };
            }
            return {
              splitKind: split.splitKind,
              categoryId: split.categoryId || undefined,
              transferAccountId: split.transferAccountId || undefined,
              investment: split.investment,
              amount: Number(split.amount),
              memo: split.memo || undefined,
            };
          }),
        );
      } else if (scheduled.splits && scheduled.splits.length > 0) {
        transactionPayload.splits = await Promise.all(
          scheduled.splits.map(async (split) => {
            if (split.kind === SplitKind.INVESTMENT && split.investmentAction) {
              const quantity =
                split.investmentQuantity !== null &&
                split.investmentQuantity !== undefined
                  ? Number(split.investmentQuantity)
                  : 0;
              const price =
                split.investmentPrice !== null &&
                split.investmentPrice !== undefined
                  ? Number(split.investmentPrice)
                  : 0;
              const commission =
                split.investmentCommission !== null &&
                split.investmentCommission !== undefined
                  ? Number(split.investmentCommission)
                  : 0;
              // Recompute the split's rate AND cash amount from the effective
              // (stored-if-valid, else re-resolved) rate so the two agree at
              // posting (issue #1167). Otherwise a re-resolved rate beside a
              // stale stored amount fails createEmbeddedForSplit's check.
              const eff = await this.effectiveAmounts.resolveEffectiveSplitCash(
                userId,
                scheduled.accountId,
                split.investmentSecurityId,
                split.investmentAction,
                quantity,
                price,
                commission,
                split.investmentExchangeRate,
                split.investmentExchangeRateFromCurrency,
                split.investmentExchangeRateToCurrency,
                postDate,
              );
              return {
                splitKind: split.kind,
                categoryId: split.categoryId || undefined,
                transferAccountId: split.transferAccountId || undefined,
                investment: {
                  action: split.investmentAction,
                  securityId: split.investmentSecurityId || undefined,
                  quantity,
                  price,
                  commission,
                  exchangeRate: eff.rate,
                },
                amount: eff.amount,
                memo: split.memo || undefined,
                tagIds:
                  split.tags && split.tags.length > 0
                    ? split.tags.map((t) => t.id)
                    : undefined,
              };
            }
            return {
              splitKind: split.kind,
              categoryId: split.categoryId || undefined,
              transferAccountId: split.transferAccountId || undefined,
              investment: undefined,
              amount: Number(split.amount),
              memo: split.memo || undefined,
              tagIds:
                split.tags && split.tags.length > 0
                  ? split.tags.map((t) => t.id)
                  : undefined,
            };
          }),
        );
      }

      // Investment split amounts above are recomputed from the effective FX rate
      // (issue #1167), on every surface -- inline, override and base scheduled
      // splits. A re-resolved rate produces a new cash amount, so the parent must
      // be re-summed to match or `validateSplitAmountSum` refuses the whole post.
      // Inline splits are re-resolved too (F5-1), so their parent must be re-summed
      // as well -- the client's parent amount was computed from the stale rate.
      const hasInvestmentSplits =
        Array.isArray(transactionPayload.splits) &&
        transactionPayload.splits.some((s: any) => s.investment);
      if (hasInvestmentSplits) {
        transactionPayload.amount = sumMoney(
          transactionPayload.splits.map((s: any) => Number(s.amount)),
        );
      }
    } else {
      const finalCategoryId = hasInlineCategoryId
        ? postDto.categoryId
        : storedOverride?.categoryId !== null &&
            storedOverride?.categoryId !== undefined
          ? storedOverride.categoryId
          : scheduled.categoryId || undefined;
      transactionPayload.categoryId = finalCategoryId || undefined;
    }

    // A transfer's authorization is decided here, before the transaction opens.
    //
    // `accountAccessFor` loads the account by id under `withSystemContext` --
    // learning a foreign account's owner is the decision input -- and a
    // system-identity `withScopedDb` cannot join a user-identity transaction:
    // it throws `IDENTITY_MISMATCH_MESSAGE` rather than quietly running under
    // the outer GUCs. Calling `createTransfer` inside the block below therefore
    // failed every scheduled transfer post, cron and manual alike. Preparing
    // first is also the standing rule (docs/backend/database-access-and-tenancy.md: "Decide authorization
    // first"), and it puts the transfer's reads in the same place as the FX
    // lookup -- above the transaction, with everything else that reaches
    // outside it.
    const transferCategoryId = hasInlineCategoryId
      ? postDto.categoryId
      : storedOverride?.categoryId !== null &&
          storedOverride?.categoryId !== undefined
        ? storedOverride.categoryId
        : scheduled.categoryId || undefined;
    const preparedTransfer =
      !scheduled.isInvestment &&
      scheduled.isTransfer &&
      scheduled.transferAccountId
        ? await this.transactionsService.prepareTransfer(userId, {
            fromAccountId: scheduled.accountId,
            toAccountId: scheduled.transferAccountId,
            amount: Math.abs(finalAmount),
            transactionDate: postDate,
            // Currency codes are deliberately not sent: the transfer service
            // derives both from the accounts. A schedule stores only its source
            // currency, so supplying that and nothing else is what made a
            // cross-currency scheduled transfer post at 1:1 with the
            // destination row mislabelled (audit P5-002). Sending a stored code
            // that has since gone stale would now fail the posting instead,
            // which is no better.
            description: finalDescription || undefined,
            referenceNumber: postDto?.referenceNumber || undefined,
            payeeId: scheduled.payeeId || undefined,
            payeeName: scheduled.payeeName || undefined,
            // Carry the schedule's category onto the posted transfer (both
            // legs), so a categorized scheduled transfer behaves like a one-off
            // one (#743). Same precedence as the non-transfer branch: inline
            // override > stored occurrence override > the schedule's own
            // category.
            categoryId: transferCategoryId || undefined,
            tagIds:
              scheduled.tagIds && scheduled.tagIds.length > 0
                ? scheduled.tagIds
                : undefined,
          })
        : null;

    // ONE transaction from here down: the occurrence claim, the money it
    // creates, the override it consumes and the schedule advancement.
    //
    // Before this, the financial transaction committed in its own transaction
    // and `nextDueDate` advanced in a second one. Every way of getting between
    // the two produced the same bill paid twice -- two replicas firing the same
    // hourly cron, a manual post racing it, or a crash after the money
    // committed. Opening balance 100.00 and one due -50.00: the account ends at
    // 0.00 instead of 50.00 (audit P4-004).
    //
    // Nested service calls join this transaction, so a refusal below rolls the
    // money back with it. The schedule's own account-currency FX lookup
    // (resolveFxForPosting) has already run above. One external call is NOT
    // hoisted: an investment's cash-settlement FX is resolved inside
    // postInvestment -> InvestmentTransactionsService.create, which can fetch a
    // cross-currency rate from the quote provider while this lock is held. That
    // is a pre-existing cost (a network round-trip inside the transaction), not
    // a correctness bug -- rollback still unwinds cleanly -- and is tracked as a
    // follow-up rather than reshaped here.
    let writtenTransfer: { savedFromId: string; savedToId: string } | undefined;
    // A managed loan bill whose debt is already retired posts NO money. The
    // occurrence is still claimed and the schedule still advances, so nothing
    // retries it; the post-commit recalculation then deactivates the schedule
    // (a revolving line of credit stays active, since it can be drawn again).
    let skipFinancialWrite = false;
    const removedAfterOnce = await withScopedDb(this.dataSource, async (m) => {
      // Lock the schedule and confirm this occurrence is still the due one. A
      // poster that lost the race finds next_due_date already advanced.
      const current = await m.findOne(ScheduledTransaction, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!current) {
        throw new NotFoundException(
          tr(
            "errors.scheduled.notFound",
            `Scheduled transaction with ID ${id} not found`,
            { id },
          ),
        );
      }
      if (ensureYMD(current.nextDueDate) !== nextDueDateStr) {
        throw new ConflictException(
          tr(
            "errors.scheduled.occurrenceAlreadyPosted",
            "This occurrence has already been posted.",
          ),
        );
      }

      // Cron selected this row when it was active and auto-posting; if the user
      // turned either off after selection but before the lock, the automatic
      // post must not fire (issue #1154 re-review). Manual posts do not pass this
      // option, so an explicit user post of an inactive schedule still works.
      if (
        options.requireActiveAutoPost &&
        (!current.isActive || !current.autoPost)
      ) {
        throw new ConflictException(
          tr(
            "errors.scheduled.changedConcurrently",
            "The scheduled transaction changed during the operation. Reload it and retry.",
          ),
        );
      }

      // The transfer/plain payloads (preparedTransfer, transactionPayload) and
      // the FX amount were prepared from the pre-lock `scheduled` snapshot. If a
      // concurrent edit changed what the schedule *is* -- kind, accounts, amount,
      // currency, or any investment scalar -- committing the prepared write would
      // post a different operation than the row now describes (e.g. a plain
      // expense edited to a transfer, so money leaves but nothing arrives). Refuse
      // and let the caller reload (issue #1154 review). The occurrence-claim and
      // the row lock guarantee no double-post; this guards against a stale-shape
      // post. Cron treats the ConflictException as "claimed elsewhere" and skips.
      if (!sameScheduleMutationBasis(scheduled, current)) {
        throw new ConflictException(
          tr(
            "errors.scheduled.changedConcurrently",
            "The scheduled transaction changed during the operation. Reload it and retry.",
          ),
        );
      }

      // The occurrence override is a mutable row of its own, read before this
      // lock. Re-read it under the lock and refuse if it changed, so a
      // concurrently-edited override is neither posted stale nor deleted
      // unread (issue #1154 review).
      const lockedOverride = await m
        .getRepository(ScheduledTransactionOverride)
        .findOne({
          where: { scheduledTransactionId: id, originalDate: nextDueDateStr },
          lock: { mode: "pessimistic_write" },
        });
      if (
        !sameOverrideMutationBasis(storedOverride, lockedOverride) ||
        (storedOverride?.updatedAt?.getTime() ?? null) !==
          (lockedOverride?.updatedAt?.getTime() ?? null)
      ) {
        throw new ConflictException(
          tr(
            "errors.scheduled.changedConcurrently",
            "The scheduled transaction changed during the operation. Reload it and retry.",
          ),
        );
      }

      // Split lines are money-shaping, not metadata (a transfer split moves the
      // target account; an investment split creates an embedded trade), and the
      // payload built them from the pre-lock `scheduled.splits`. When the post
      // actually uses the base scheduled splits -- no inline splits and no
      // override splits -- re-read the set under the parent lock and refuse if it
      // changed, so a concurrently-retargeted split cannot post money to the old
      // account (issue #1154 re-review). This is a point-in-time comparison, so
      // what it protects against depends on when the other writer commits.
      // Writers that serialize on the parent lock (the loan recalculator) cannot
      // mutate the split set after this read at all -- the lock is held until the
      // post commits. A writer that does NOT take the parent lock can still
      // commit a change *after* this comparison and before the post commits; the
      // only such known path is bulk category reassignment, whose residual
      // effect is categorization-only (no amount or account routing changes), so
      // it is accepted here rather than made to lock every affected parent.
      const usesScheduledSplits =
        useSplits &&
        !hasInlineSplits &&
        !(lockedOverride?.splits && lockedOverride.splits.length > 0);
      if (usesScheduledSplits) {
        const currentSplits = await m
          .getRepository(ScheduledTransactionSplit)
          .find({ where: { scheduledTransactionId: id }, relations: ["tags"] });
        if (!sameScheduledSplitBasis(scheduled.splits ?? [], currentSplits)) {
          throw new ConflictException(
            tr(
              "errors.scheduled.changedConcurrently",
              "The scheduled transaction changed during the operation. Reload it and retry.",
            ),
          );
        }

        // A loan template's stored P/I split is derived state, computed when
        // the PREVIOUS occurrence posted; a principal movement committed since
        // (a standalone overpayment, a void, an import) leaves it stale, and no
        // mutation path recalculates it. So the occurrence being posted
        // re-resolves its allocation from the ledger through its own due date,
        // here at the consumption boundary -- under the parent lock, inside
        // this transaction (issue #1253, finding PR-1254-01). When nothing
        // moved in between this resolves to the persisted amounts exactly.
        //
        // Only the plain base-split path resolves: an inline or override
        // amount is the user's explicit statement for this occurrence, an FX
        // schedule prices in another currency, and investments/transfers do
        // not carry the loan template shape. The resolver itself returns null
        // for anything that is not a managed loan template.
        if (
          !current.isInvestment &&
          !preparedTransfer &&
          !fx &&
          !hasInlineAmount &&
          storedOverride?.amount == null
        ) {
          // The boundary is the date this occurrence's money actually moves --
          // `postDate`, which an override can move off the recurrence slot --
          // because that is the date the interest accrues to.
          // Held from here until commit, so the debt this prices cannot move
          // underneath it.
          await this.lockLoanLedgerForPricing(
            m,
            userId,
            current.accountId,
            currentSplits,
          );
          const loanAllocation =
            await this.loanService.resolvePostingAllocation(
              current,
              currentSplits,
              postDate,
            );
          // The payload rows were mapped 1:1 (in order) from the pre-lock
          // scheduled.splits, which the basis guard above just proved
          // identical to the locked set -- so the source split id addresses
          // each payload row.
          const applyLineAmounts = (amountsBySplitId: Map<string, number>) => {
            transactionPayload.splits = transactionPayload.splits.map(
              (payloadSplit: any, index: number) => {
                const sourceId = scheduled.splits?.[index]?.id;
                const resolvedAmount = sourceId
                  ? amountsBySplitId.get(sourceId)
                  : undefined;
                return resolvedAmount !== undefined
                  ? { ...payloadSplit, amount: resolvedAmount }
                  : payloadSplit;
              },
            );
          };
          if (loanAllocation.kind === "retired") {
            // Nothing is owed through this occurrence's boundary, and every
            // line of this bill is one the payoff settles. Consume the
            // occurrence without moving money: charging the stale installment
            // would record interest against a debt that no longer exists and
            // push the loan into credit.
            skipFinancialWrite = true;
          } else if (loanAllocation.kind === "allocation") {
            applyLineAmounts(loanAllocation.amountsBySplitId);
            // A re-resolved child moves the parent with it, or the split
            // validator's exact-4dp equality refuses the whole post.
            transactionPayload.amount = sumMoney(
              transactionPayload.splits.map((s: any) => Number(s.amount)),
            );
          } else if (
            !transactionPayload.splits.some((s: any) => s.investment)
          ) {
            // A template the loan pricing does not re-divide (no loan, or one
            // carrying an escrow line) is booked in the currency's smallest
            // unit all the same, exactly as the Post dialog pre-fills it, so
            // the occurrence does not post 1,170.6458 from one button and
            // 1,170.65 from the other (issue #1581). An investment line's
            // amount is its trade's cash impact and is not rounded here.
            const booked = await this.loanService.bookTemplateAtMinorUnit(
              current,
              currentSplits,
            );
            applyLineAmounts(booked.amountsBySplitId);
            transactionPayload.amount = booked.parentAmount;
          }
        }
      }

      // The same re-resolution for the manual Post dialog, which is the path
      // users actually take and which does NOT reach the block above: the
      // dialog echoes the stored template back as INLINE splits, so
      // `usesScheduledSplits` is false and the occurrence would post the stale
      // allocation the auto-post path just learned to avoid -- the same
      // occurrence posting two different amounts depending on which button was
      // pressed.
      //
      // An echo is not an instruction. Each inline line names its source split
      // (`sourceSplitId`), so an UNCHANGED echo re-resolves while a figure the
      // user actually typed is honoured -- the distinction the FX path above
      // already draws for a rate the dialog round-trips (issue #1167 F5-1).
      if (
        useSplits &&
        hasInlineSplits &&
        !current.isInvestment &&
        !preparedTransfer &&
        !fx
      ) {
        const lockedSplits = await m
          .getRepository(ScheduledTransactionSplit)
          .find({ where: { scheduledTransactionId: id } });
        const storedById = new Map(
          lockedSplits.map((split) => [
            split.id,
            roundMoney(Number(split.amount)),
          ]),
        );
        const rows = transactionPayload.splits as any[];
        // The dialog sends the parent `amount` on EVERY non-foreign post -- it
        // is the same echo the lines are, not a typed instruction -- so gating
        // this on `!hasInlineAmount` made the whole block unreachable from the
        // only surface that produces inline splits. The amount is an echo when
        // it still equals what the locked template holds; a figure the user
        // actually changed is their statement and posts as given.
        const echoes = (
          parentAmount: number,
          lineAmounts: Map<string, number>,
        ): boolean =>
          (!hasInlineAmount ||
            roundMoney(Number(postDto?.amount)) === roundMoney(parentAmount)) &&
          Array.isArray(rows) &&
          rows.length === lockedSplits.length &&
          rows.every((row, index) => {
            const sourceId = postDto?.splits?.[index]?.sourceSplitId;
            return (
              !!sourceId &&
              lineAmounts.has(sourceId) &&
              lineAmounts.get(sourceId) === roundMoney(Number(row.amount))
            );
          });
        // Every line must echo a stored line at its stored amount; one typed
        // figure (or one line that names no source) makes the whole set the
        // user's own statement, which posts as given. The dialog pre-fills a
        // template priced at 4dp in the currency's smallest unit, the rounding
        // difference on the principal line (issue #1581), so that booking of
        // the stored template is an echo too -- compared exactly, never with a
        // tolerance, so a cent the user typed is still theirs.
        const exactEcho = echoes(Number(current.amount), storedById);
        const bookedTemplate = exactEcho
          ? null
          : await this.loanService.bookTemplateAtMinorUnit(
              current,
              lockedSplits,
            );
        const isUnchangedEcho =
          exactEcho ||
          (bookedTemplate !== null &&
            echoes(
              bookedTemplate.parentAmount,
              bookedTemplate.amountsBySplitId,
            ));
        if (isUnchangedEcho) {
          await this.lockLoanLedgerForPricing(
            m,
            userId,
            current.accountId,
            lockedSplits,
          );
          const loanAllocation =
            await this.loanService.resolvePostingAllocation(
              current,
              lockedSplits,
              postDate,
            );
          if (loanAllocation.kind === "retired") {
            skipFinancialWrite = true;
          } else if (loanAllocation.kind === "allocation") {
            transactionPayload.splits = rows.map((row, index) => {
              const sourceId = postDto?.splits?.[index]?.sourceSplitId;
              const resolved = sourceId
                ? loanAllocation.amountsBySplitId.get(sourceId)
                : undefined;
              return resolved !== undefined
                ? { ...row, amount: resolved }
                : row;
            });
            transactionPayload.amount = sumMoney(
              transactionPayload.splits.map((s: any) => Number(s.amount)),
            );
          }
        }
      }

      // Claim the occurrence. The unique key on
      // (scheduled_transaction_id, original_due_date) is what makes the claim
      // the serialization point rather than the lock alone: it survives a
      // crash, and manual and automatic posting both go through it, as does
      // a rule's settlement of a bank row against the same occurrence
      // (INV-LOAN-008).
      const claimed = returnedRows<{ id: string }>(
        await m.query(
          `INSERT INTO scheduled_transaction_postings
             (scheduled_transaction_id, original_due_date, posted_date)
           VALUES ($1, $2, $3)
           ON CONFLICT (scheduled_transaction_id, original_due_date) DO NOTHING
           RETURNING id`,
          [id, nextDueDateStr, postDate],
        ),
      );
      if (claimed.length === 0) {
        throw new ConflictException(
          tr(
            "errors.scheduled.occurrenceAlreadyPosted",
            "This occurrence has already been posted.",
          ),
        );
      }
      const claimId = claimed[0].id;

      if (current.isInvestment) {
        // Post from the locked row, not the pre-lock `scheduled` snapshot: a
        // concurrent edit that switched the action/funding/security between the
        // snapshot read and this lock would otherwise post the stale action to
        // the stale account (issue #1154 review). `current` carries the
        // authoritative scalar investment fields; postInvestment reads only
        // those, and the nested create resolves its own settlement account.
        await this.postInvestment(
          userId,
          current,
          postDto,
          postDate,
          lockedOverride,
        );
      } else if (preparedTransfer) {
        // Already validated and authorized above; only the writes join this
        // transaction, so the legs and their balance updates commit with the
        // occurrence claim.
        writtenTransfer = await this.transactionsService.writeTransferLegs(
          preparedTransfer,
          m,
        );
        await this.recordClaimTransaction(
          m,
          claimId,
          writtenTransfer.savedFromId,
        );
      } else if (!skipFinancialWrite) {
        const created = await this.transactionsService.create(
          userId,
          transactionPayload,
          {
            // Server-set: the row pays the occurrence claimed above, so the
            // owner's settlement rules refuse it (row_from_scheduled_posting).
            fromScheduledPosting: true,
            ...(options.actorIsNotOwner === true
              ? { actorIsNotOwner: true }
              : {}),
          },
        );
        await this.recordClaimTransaction(m, claimId, created.id);
      } else {
        this.logger.log(
          `Scheduled loan payment ${id} posted no money: the loan owes nothing ` +
            `through ${postDate}. The occurrence is consumed so it is not retried; ` +
            `the schedule deactivates unless it is a revolving line of credit.`,
        );
      }

      if (lockedOverride) {
        await m.remove(lockedOverride);
      }

      if (current.frequency === "ONCE") {
        // One-time bill or deposit: remove the scheduled transaction entirely
        // after posting so it disappears from the Bills & Deposits page.
        // Splits, overrides and the posting claim are cleaned up via
        // ON DELETE CASCADE.
        await m.delete(ScheduledTransaction, id);
        return true;
      }

      // Recurring frequency: advance nextDueDate, prune stale overrides,
      // decrement occurrencesRemaining, deactivate if past endDate.
      //
      // From `current`, the locked row, not from the `scheduled` snapshot
      // taken before the transaction: a concurrent edit to occurrencesRemaining
      // or endDate would otherwise be reverted by this advancement. The one
      // consumed slot is the occurrence claimed above.
      await advanceScheduleCursor(m, current, new Set([nextDueDateStr]));
      return false;
    });

    // The transfer's post-commit half: net-worth recalculation, tags and the
    // action-history entry. Deliberately after the transaction rather than
    // inside it -- the history recorder swallows its own failures, so nesting it
    // would either abort the posting with `25P02` or lose the undo entry.
    if (preparedTransfer && writtenTransfer) {
      await this.transactionsService.completeTransfer(
        preparedTransfer,
        writtenTransfer.savedFromId,
        writtenTransfer.savedToId,
      );
    }

    if (removedAfterOnce) {
      return null;
    }

    if (scheduled.splits && scheduled.splits.length > 0) {
      // Do not pass a loan id captured off the pre-lock snapshot: the
      // recalculation locks the parent and derives the loan from the current
      // split set itself, so a concurrent retarget (Loan A -> Loan B) cannot
      // recalculate the wrong loan (issue #1154 re-review).
      await this.loanService.recalculateLoanPaymentSplits(id);
    }

    return this.findOne(userId, id);
  }

  /**
   * Name the transaction a claim's occurrence was paid by
   * (`docs/specs/loan-installment-settlement.md` section 5.2), in the same
   * transaction as the claim, once the create has returned the id. From here
   * on deleting that transaction releases the claim (`ON DELETE CASCADE`),
   * for every schedule, and a settlement rule reads the row as a posted bill
   * (`row_from_scheduled_posting`). An investment post records nothing: it
   * writes through the investment service, and nothing reads which of its
   * rows paid the occurrence.
   */
  private async recordClaimTransaction(
    m: EntityManager,
    claimId: string,
    transactionId: string,
  ): Promise<void> {
    await m.query(
      `UPDATE scheduled_transaction_postings SET transaction_id = $1 WHERE id = $2`,
      [transactionId, claimId],
    );
  }

  /**
   * Serialize this posting against anyone else moving the loan's ledger.
   *
   * The occurrence's interest is `debt(d) x rate`, and that debt is read from
   * the `transactions` table. The schedule row lock does not protect it: no
   * ledger writer takes that lock, so under READ COMMITTED a principal payment
   * can commit between this posting's debt `SELECT` and its own write, and the
   * split would be priced from a balance that was already stale when it was
   * written (`CONC-001`: a financial input is read under the lock that
   * authorizes the write, not merely inside the same transaction).
   *
   * `lockAccountsForBalanceWrite` is the existing primitive for exactly this --
   * every balance writer already takes it, so holding it from before the read
   * until commit forces a concurrent ledger write to queue behind this posting
   * rather than slip inside it. Both accounts are locked because both move:
   * the source pays and the loan receives. The primitive sorts, which is what
   * keeps two postings over the same pair deadlock-free.
   *
   * Returns the loan account id when there is one, so the caller can tell a
   * loan template from an ordinary split without asking again.
   */
  private async lockLoanLedgerForPricing(
    m: EntityManager,
    userId: string,
    sourceAccountId: string,
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    const loanAccountId =
      await this.loanService.findLoanAccountFromSplits(splits);
    if (!loanAccountId) return null;
    await lockAccountsForBalanceWrite(
      m,
      [sourceAccountId, loanAccountId],
      userId,
    );
    return loanAccountId;
  }

  private async postInvestment(
    userId: string,
    scheduled: ScheduledTransaction,
    postDto: PostScheduledTransactionDto | undefined,
    postDate: string,
    storedOverride: ScheduledTransactionOverride | null,
  ): Promise<void> {
    const action = scheduled.investmentAction as InvestmentAction | null;
    if (!action) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.missingInvestmentAction",
          "Scheduled investment transaction is missing an action",
        ),
      );
    }

    // Precedence for investment fields at post time: explicit postDto value
    // (one-time tweak entered in the Post dialog) > stored per-occurrence
    // override (saved on a future occurrence) > base scheduled transaction.
    const pickInvestmentValue = (
      inline: number | null | undefined,
      override: number | null | undefined,
      base: number | null | undefined,
    ): number | undefined => {
      if (inline !== undefined && inline !== null) return Number(inline);
      if (override !== undefined && override !== null) return Number(override);
      if (base !== undefined && base !== null) return Number(base);
      return undefined;
    };

    const quantity = pickInvestmentValue(
      postDto?.investmentQuantity,
      storedOverride?.investmentQuantity,
      scheduled.investmentQuantity,
    );

    const price = pickInvestmentValue(
      postDto?.investmentPrice,
      storedOverride?.investmentPrice,
      scheduled.investmentPrice,
    );

    const totalAmount = pickInvestmentValue(
      postDto?.investmentTotalAmount,
      storedOverride?.investmentTotalAmount,
      scheduled.investmentTotalAmount,
    );

    const commission =
      scheduled.investmentCommission !== null &&
      scheduled.investmentCommission !== undefined
        ? Number(scheduled.investmentCommission)
        : undefined;

    let exchangeRate =
      scheduled.investmentExchangeRate !== null &&
      scheduled.investmentExchangeRate !== undefined
        ? Number(scheduled.investmentExchangeRate)
        : undefined;

    // Issue #1167: a stored rate is only reused when its recorded currency pair
    // still matches the current settlement pair (security currency -> settlement
    // account currency). If the referenced security or account changed currency
    // since the rate was stored, the pair no longer matches, so drop the scalar
    // and let the posting resolver re-resolve a fresh rate for the current pair.
    // A rate with no recorded pair (a row written before this change) is unknown,
    // not current, so it is dropped and re-resolved too -- never trusted.
    if (
      exchangeRate !== undefined &&
      !(await this.effectiveAmounts.storedInvestmentRateIsCurrent(
        userId,
        scheduled.investmentExchangeRateFromCurrency,
        scheduled.investmentExchangeRateToCurrency,
        {
          accountId: scheduled.accountId,
          fundingAccountId: FUNDING_ACCOUNT_ACTIONS.has(action)
            ? scheduled.investmentFundingAccountId
            : null,
          securityId: scheduled.investmentSecurityId,
        },
      ))
    ) {
      exchangeRate = undefined;
    }

    const description =
      postDto?.description !== undefined
        ? postDto.description || undefined
        : scheduled.description || undefined;

    // Post-time overrides (inline > occurrence override > schedule) are another
    // write boundary that create/update validation does not cover, and internal
    // callers (cron, MCP) bypass the controller DTO. Revalidate the resolved
    // values before creating money, so an override cannot post a zero BUY
    // quantity or a negative dividend total (issue #1154 review). Amount-only
    // actions may express the total as quantity*price, so mirror that here.
    const effectiveAmountOnlyTotal =
      totalAmount !== undefined
        ? totalAmount
        : quantity !== undefined && price !== undefined
          ? quantity * price
          : undefined;
    this.validateInvestmentFields({
      investmentAction: action,
      investmentSecurityId: scheduled.investmentSecurityId,
      investmentQuantity: quantity,
      investmentPrice: price,
      investmentTotalAmount: effectiveAmountOnlyTotal,
      investmentExchangeRate: exchangeRate,
    });

    const dto: any = {
      accountId: scheduled.accountId,
      action,
      transactionDate: postDate,
      securityId: scheduled.investmentSecurityId || undefined,
      // Only a BUY/SELL settles through the funding account; for any other
      // action the cash belongs in the brokerage's linked cash account, so a
      // stale funding account left on the row is ignored rather than allowed to
      // misroute the money (issue #1154). This also repairs rows that were
      // already stored with a stale funding account before the write-path fix.
      fundingAccountId: FUNDING_ACCOUNT_ACTIONS.has(action)
        ? scheduled.investmentFundingAccountId || undefined
        : undefined,
      description,
    };

    if (QUANTITY_PRICE_ACTIONS.has(action)) {
      dto.quantity = quantity;
      dto.price = price;
      if (commission !== undefined) dto.commission = commission;
    } else if (QUANTITY_ONLY_ACTIONS.has(action)) {
      dto.quantity = quantity;
    } else if (AMOUNT_ONLY_ACTIONS.has(action)) {
      // InvestmentTransactionsService computes total_amount from price * quantity
      // for these amount-only actions; pass the desired total via price with
      // quantity=1 if no quantity/price is set, or honour the stored values.
      if (
        quantity !== undefined &&
        price !== undefined &&
        totalAmount === undefined
      ) {
        dto.quantity = quantity;
        dto.price = price;
      } else if (totalAmount !== undefined) {
        dto.quantity = 1;
        dto.price = totalAmount;
      }
    }

    // Unlike the funding account above, the stored exchange rate is forwarded
    // for every action rather than gated on FUNDING_ACCOUNT_ACTIONS. That is
    // deliberate and asymmetric: a cross-currency DIVIDEND/INTEREST/CAPITAL_GAIN
    // legitimately settles at a rate, so it cannot simply be dropped for
    // non-BUY/SELL actions the way the funding account can. The rate is only
    // forwarded when its stored currency pair still matches the current
    // settlement pair -- the staleness check above already reset `exchangeRate`
    // to undefined otherwise, so a rate for a pair that no longer applies falls
    // through to fresh resolution in the posting resolver (issue #1167).
    if (exchangeRate !== undefined) dto.exchangeRate = exchangeRate;

    await this.investmentTransactionsService.create(userId, dto);
  }

  private calculateNextDueDate(
    currentDate: Date | string,
    frequency: FrequencyType,
  ): Date {
    const ymd = ensureYMD(currentDate);
    const next = calcNextDueDate(ymd, frequency);
    return new Date(`${next}T00:00:00.000Z`);
  }

  // Delegated override methods

  /**
   * The currency-pair provenance for each override investment split that carries
   * a rate (issue #1167), keyed by split index, decided through the one shared
   * rule (`decideSplitProvenance`). An override split settles through the
   * parent's INVESTMENT_CASH account with no separate funding account, exactly
   * like an embedded scheduled split. Only indices whose investment supplies a
   * rate get an entry; the rest re-resolve at posting.
   *
   * `source` is the rows the incoming splits may continue: the base scheduled
   * splits when creating an override (so an inherited stale scalar is not
   * re-blessed with the current pair, R9-F1), or the existing override's splits
   * when updating one.
   */
  private async buildOverrideInvestmentProvenance(
    userId: string,
    accountId: string,
    source: {
      byId: Map<
        string,
        { rate: number | null; from: string | null; to: string | null }
      >;
      byKey: Map<string, { from: string; to: string }>;
    },
    splits: OverrideSplitDto[] | null | undefined,
  ): Promise<Map<number, { from: string | null; to: string | null }>> {
    const provenance = new Map<
      number,
      { from: string | null; to: string | null }
    >();
    for (const [index, s] of (splits ?? []).entries()) {
      const inv = s.investment;
      if (inv?.exchangeRate === undefined || inv?.exchangeRate === null)
        continue;
      // A rate-carrying split with NO securityId must still get a server-decided
      // pair: the override split's pair travels in the client-supplied jsonb, so
      // skipping it left the client's echoed `exchangeRateFromCurrency`/`ToCurrency`
      // persisted verbatim -- the one write shape where provenance was
      // client-asserted rather than server-derived (issue #1167 review). The pair
      // is resolvable server-side (source = the account's currency for a
      // security-less action); `decideSplitProvenance` keys the value-carry by
      // security and so leaves a security-less new line unprovenanced, but a
      // sourceSplitId match still carries its recorded pair forward.
      const securityId = inv.securityId ?? null;
      const pair = await this.decideSplitProvenance(
        {
          sourceSplitId: s.sourceSplitId,
          rateExplicit: s.rateExplicit,
          securityId,
          rate: Number(inv.exchangeRate),
        },
        source,
        () =>
          this.investmentTransactionsService.resolveSettlementCurrencyPair(
            userId,
            accountId,
            null,
            securityId,
          ),
      );
      provenance.set(index, pair);
    }
    return provenance;
  }

  async createOverride(
    userId: string,
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    const scheduled = await this.findOne(userId, scheduledTransactionId);
    // A new override inherits the base scheduled splits (their id, rate and
    // recorded pair), so decide provenance against them as the source: an
    // inherited unchanged rate keeps its base pair (incl. a stale one, caught at
    // posting) rather than being re-stamped with the current pair (issue #1167
    // R9-F1). A genuinely new or re-entered line still stamps the current pair.
    const investmentProvenance = await this.buildOverrideInvestmentProvenance(
      userId,
      scheduled.accountId,
      this.buildSplitProvenanceSource(scheduled.splits ?? []),
      createDto.splits,
    );
    return this.overrideService.createOverride(
      scheduledTransactionId,
      createDto,
      investmentProvenance,
    );
  }

  async findOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverrides(scheduledTransactionId);
  }

  async findOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverride(
      scheduledTransactionId,
      overrideId,
    );
  }

  async findOverrideByDate(
    userId: string,
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverrideByDate(
      scheduledTransactionId,
      date,
    );
  }

  async updateOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    const scheduled = await this.findOne(userId, scheduledTransactionId);
    // Provenance belongs to the rate+pair tuple (issue #1167 re-review). A resent
    // *unchanged* override split rate carries the pair the existing override
    // recorded forward (still-valid rates keep working, since-stale ones are
    // caught at posting). A *changed* rate (re-entered for the new pair) or a new
    // security stamps the current pair -- never the old one, which would reject a
    // rate the user just entered.
    const existing = await this.overrideService.findOverride(
      scheduledTransactionId,
      overrideId,
    );
    // Decide each split's FX provenance against the *existing* override's splits
    // as the source, through the one shared rule (issue #1167 R9).
    const investmentProvenance = await this.buildOverrideInvestmentProvenance(
      userId,
      scheduled.accountId,
      this.buildOverrideProvenanceSource(existing.splits),
      updateDto.splits,
    );
    return this.overrideService.updateOverride(
      scheduledTransactionId,
      overrideId,
      updateDto,
      investmentProvenance,
    );
  }

  async removeOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.removeOverride(
      scheduledTransactionId,
      overrideId,
    );
  }

  async removeAllOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<number> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.removeAllOverrides(scheduledTransactionId);
  }

  async hasOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.hasOverrides(scheduledTransactionId);
  }

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
  ): Promise<void> {
    return this.loanService.recalculateLoanPaymentSplits(
      scheduledTransactionId,
    );
  }

  /** See `ScheduledTransactionLoanService.repriceLoanTemplate`. */
  async repriceLoanTemplate(scheduledTransactionId: string): Promise<void> {
    return this.loanService.repriceLoanTemplate(scheduledTransactionId);
  }

  async getLoanProjectionAnchor(
    userId: string,
    loanAccountId: string,
  ): Promise<{ nextDueDate: string | null; debt: number | null }> {
    return this.loanService.getLoanProjectionAnchor(userId, loanAccountId);
  }

  /** See `ScheduledTransactionLoanService.projectLoanOccurrences`. */
  async projectLoanOccurrences(
    userId: string,
    scheduledTransactionId: string,
    count: number,
  ): Promise<LoanOccurrencesProjection> {
    return this.loanService.projectLoanOccurrences(
      userId,
      scheduledTransactionId,
      count,
    );
  }
}

/**
 * What ONE occurrence is, for a model reading the list.
 *
 * The direction comes from the occurrence (`directionAmount`), never from the
 * schedule's stored amount: a mixed-sign split parent's effective amount can sit
 * on the other side of zero from its snapshot, and reading the snapshot reported
 * a re-priced inflow as a bill (see `ScheduledOccurrenceService`).
 */
function classifyScheduledKind(
  occurrence: ResolvedScheduledOccurrence,
): LlmScheduledKind {
  const row = occurrence.schedule;
  if (row.isTransfer) return "transfer";
  if (row.isInvestment) return "investment";
  if (occurrence.directionAmount === null) return "unknown";
  return occurrence.directionAmount < 0 ? "bill" : "deposit";
}

function daysBetweenYMD(fromYMD: string, toYMD: string): number {
  const from = new Date(`${fromYMD}T00:00:00.000Z`).getTime();
  const to = new Date(`${toYMD}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

/**
 * One occurrence, as the AI Assistant and MCP publish it.
 *
 * `nextDueDate` is the occurrence's own due date -- the moved date when an
 * override moved it, not the recurrence slot it replaced. A schedule whose next
 * occurrence was pushed a week out used to be announced on the original date and
 * priced from the template, which is two wrong answers about one bill.
 */
function toLlmScheduledItem(
  occurrence: ResolvedScheduledOccurrence,
  todayYMDStr: string,
): LlmScheduledItem {
  const row = occurrence.schedule;
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    accountName: row.account?.name ?? "",
    payeeName: row.payee?.name ?? row.payeeName ?? null,
    categoryName: row.category?.name ?? null,
    amount: occurrence.amount,
    amountComplete: occurrence.complete,
    currency: occurrence.currencyCode,
    frequency: row.frequency,
    nextDueDate: occurrence.dueDate,
    daysUntilDue: daysBetweenYMD(todayYMDStr, occurrence.dueDate),
    isActive: row.isActive,
    autoPost: row.autoPost,
    kind: classifyScheduledKind(occurrence),
    description: row.description ?? null,
  };
}

function matchesScheduledFilter(
  item: LlmScheduledItem,
  filter: LlmScheduledFilter,
): boolean {
  if (filter.kind && filter.kind !== "all" && item.kind !== filter.kind) {
    return false;
  }
  if (filter.isActive !== undefined && item.isActive !== filter.isActive) {
    return false;
  }
  if (
    filter.accountIds &&
    filter.accountIds.length > 0 &&
    !filter.accountIds.includes(item.accountId)
  ) {
    return false;
  }
  return true;
}
