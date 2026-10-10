import { Injectable } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  ScheduledEffectiveAmountService,
  overrideEffectiveKey,
} from "./scheduled-effective-amount.service";
import {
  OccurrenceWindow,
  expandOccurrenceSlots,
} from "../common/scheduled-occurrences";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { withScopedDb } from "../common/db/scoped-db";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { ensureYMD } from "../common/recurrence";
import {
  LoanOccurrencesProjection,
  ScheduledTransactionLoanService,
} from "./scheduled-transaction-loan.service";

/**
 * How far ahead of today a loan bill's occurrences after the next are priced
 * per occurrence (spec 8.7): one year, through the same date next year
 * whichever of the two is a leap year. An occurrence due later keeps the
 * template's amount, as every occurrence did before the projection.
 */
export const LOAN_OCCURRENCE_HORIZON_DAYS = 366;

/**
 * One occurrence of one schedule, priced at what it would post *today*.
 *
 * This is the server-authoritative occurrence contract issue #1247 asks for. The
 * effective-amount service answers "what does this schedule cost"; this answers
 * "what does THIS occurrence cost, and when does it fall" -- the question every
 * bills, budget, report, export, AI and MCP surface actually asks. Centralizing
 * the arithmetic was not enough on its own: each consumer still had to know that
 * the occurrence's identity is `originalDate`, that `overrideDate` moves it, and
 * which member of the resolver's result to read -- and they did not agree.
 *
 * `amount` is `null` exactly when the occurrence's current amount is unknown, and
 * `null` is never a licence to fall back to `ScheduledTransaction.amount`: that
 * scalar is a snapshot taken at whatever FX rate was current when it was written.
 * A consumer renders the occurrence as unavailable and withholds any total
 * containing it.
 */
export interface EffectiveScheduledOccurrence {
  scheduledTransactionId: string;
  /** The recurrence slot this occurrence came from -- its identity. */
  originalDate: string;
  /** The date it actually falls on: the override's date when one moved it. */
  dueDate: string;
  /** What this occurrence would post today, or `null` when that is unknown. */
  amount: number | null;
  /**
   * The signed amount that decides this occurrence's DIRECTION -- bill or
   * deposit, outflow or income -- or `null` when the direction cannot be derived.
   *
   * `amount` when it is known. When it is not, the schedule's snapshot stands in
   * only where its sign is *provable* without the missing rate: a top-level
   * investment is one scalar times one positive rate, and a split whose lines all
   * point the same way stays on that side of zero because an investment line's
   * cash impact is signed by its action.
   *
   * `null` is the mixed-sign aggregate: a +10 parent made of a fixed +100 beside
   * an unpriceable BUY posts -20 at one rate and +20 at another, so asserting
   * either side is inventing an answer. A consumer reports it as unknown -- it
   * must never fall back to `schedule.amount` itself, which is what made AI/MCP
   * call a re-priced deposit a bill and made an outflow-only filter drop the
   * reverse case. `frontend/src/lib/scheduled-kind.ts`'s `occurrenceKind` is the
   * same rule on the client.
   */
  directionAmount: number | null;
  /** The currency `amount` is expressed in (the settlement currency for an investment). */
  currencyCode: string;
  /** `amount !== null`. A total containing an incomplete occurrence is incomplete. */
  complete: boolean;
  /** The override governing this occurrence, or `null` when it runs on the base template. */
  overrideId: string | null;
  /** True when an override moved this occurrence off its recurrence slot. */
  moved: boolean;
  /**
   * The account whose balance this occurrence's cash moves through -- the
   * settlement account for an investment schedule, not the brokerage.
   */
  settlementAccountId: string;
  /** The settlement pair behind an unresolvable amount, when there is one to name. */
  settlementPair: { from: string; to: string } | null;
}

/**
 * Narrowing on *schedule* attributes, for a surface that genuinely wants fewer
 * rows. Deliberately not a general `where`: anything that decides which
 * occurrence applies belongs to this service, not to its callers.
 */
export interface OccurrenceCandidateFilter {
  /**
   * Only occurrences whose **resolved** direction is an outflow
   * (`directionAmount < 0`), plus those whose direction cannot be derived at all
   * (`null`) -- their amount is unknown as well, so the consumer's total is
   * withheld rather than quietly missing a possible outflow. A zero-amount
   * reminder is excluded, as it always was.
   *
   * Deliberately not a pure SQL predicate: the stored sign cannot answer this
   * for an FX-sensitive schedule (see `directionAmount`). The candidate read
   * narrows on the stored sign only for the shapes whose sign no rate can move,
   * keeps every FX-sensitive row, and the direction is applied to the resolved
   * occurrence afterwards.
   */
  outflowsOnly?: boolean;
  /** Only schedules the user has to post themselves. */
  manualOnly?: boolean;
}

/** An occurrence plus the row it came from, for a server-side consumer. */
export interface ResolvedScheduledOccurrence extends EffectiveScheduledOccurrence {
  schedule: ScheduledTransaction;
}

/**
 * The one place a scheduled occurrence is selected and priced (issue #1247,
 * INV-OCCURRENCE-003).
 *
 * Deliberately separate from `ScheduledTransactionsService`: budgets, the account
 * balance forecast and the AI/MCP payload all need occurrences without the
 * 4000-line write path, and a service that only reads keeps the dependency
 * one-directional.
 */
@Injectable()
export class ScheduledOccurrenceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly effectiveAmounts: ScheduledEffectiveAmountService,
    private readonly loanService: ScheduledTransactionLoanService,
  ) {}

  /**
   * The occurrences of `rows` that fall inside `window`, in due-date order.
   *
   * The caller supplies the rows (each surface filters differently -- outflows
   * only, manual-post only, one account) but **not** the overrides: this method
   * loads them itself, because "which override governs this occurrence" is
   * exactly the decision that was being made differently in each consumer. Rows
   * must carry their `splits` relation, which is what tells an FX-sensitive cash
   * total from a fixed one.
   *
   * Runs the resolver outside any read transaction of its own: the rate path can
   * fetch from a provider and persist.
   */
  async expand(
    userId: string,
    rows: ScheduledTransaction[],
    window: OccurrenceWindow,
  ): Promise<ResolvedScheduledOccurrence[]> {
    if (rows.length === 0) return [];

    const overridesBySchedule = await this.loadOverrides(rows.map((r) => r.id));

    // Hydrating `futureOverrides` is what makes the resolver price every override
    // this expansion might select. An override it did not price would read as "no
    // entry", and the substitution that follows -- the base amount standing in for
    // an occurrence the user changed -- is the defect issue #1247 is about.
    const hydrated = rows.map((row) => ({
      ...row,
      futureOverrides: overridesBySchedule.get(row.id) ?? [],
    }));
    const effective = await this.effectiveAmounts.resolveMany(userId, hydrated);

    const occurrences: ResolvedScheduledOccurrence[] = [];
    for (const row of rows) {
      // `resolveMany` answers for every row it was given, so this is total.
      const resolved = effective.get(row.id)!;
      const overrides = overridesBySchedule.get(row.id) ?? [];
      for (const slot of expandOccurrenceSlots(row, overrides, window)) {
        // Branch on the ENTRY, never on its amount: an override priced as unknown
        // reads as `null`, which `??` cannot tell from "no entry at all" -- and
        // falling through to the base amount is the substitution this contract
        // forbids.
        const own = slot.override
          ? resolved.overrides.get(overrideEffectiveKey(slot.override))
          : undefined;
        const amount = own ? own.effective : resolved.base;
        occurrences.push({
          scheduledTransactionId: row.id,
          originalDate: slot.originalDate,
          dueDate: slot.dueDate,
          amount: amount.amount,
          directionAmount: amount.directionAmount,
          currencyCode: amount.currencyCode,
          complete: amount.complete,
          overrideId: slot.override?.id ?? null,
          moved: slot.moved,
          settlementAccountId: resolved.settlementAccountId,
          settlementPair: resolved.settlementPair,
          schedule: row,
        });
      }
    }

    const priced = await this.priceLoanOccurrences(
      userId,
      occurrences,
      overridesBySchedule,
    );

    return priced.sort((a, b) =>
      a.dueDate === b.dueDate
        ? a.scheduledTransactionId.localeCompare(b.scheduledTransactionId)
        : a.dueDate.localeCompare(b.dueDate),
    );
  }

  /**
   * Every active schedule's occurrences inside `window`, in due-date order.
   *
   * The candidate query asks the occurrence-aware question rather than the
   * schedule-shaped one: a schedule whose next recurrence slot sits beyond the
   * window still has an occurrence inside it when an override moved one back, so
   * `next_due_date <= through` alone loses it.
   *
   * `filter` narrows on stable *schedule* attributes only -- never on anything
   * that decides which occurrence applies. A surface that wants fewer rows says
   * so here rather than writing its own candidate query, which is how the
   * override rules got copied in the first place.
   */
  async findOccurrences(
    userId: string,
    window: OccurrenceWindow,
    filter: OccurrenceCandidateFilter = {},
  ): Promise<ResolvedScheduledOccurrence[]> {
    const rows = await withScopedDb(this.dataSource, (m) => {
      const qb = m
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
        // The splits decide whether a schedule's cash total re-prices at the
        // current rate, which the effective-amount resolver cannot answer
        // without them.
        .leftJoinAndSelect("st.splits", "splits")
        .where("st.userId = :userId", { userId })
        .andWhere("st.isActive = :isActive", { isActive: true })
        .andWhere(
          `(st.nextDueDate <= :through OR EXISTS (
              SELECT 1 FROM scheduled_transaction_overrides o
              WHERE o.scheduled_transaction_id = st.id
                AND o.override_date <= :through
            ))`,
          { through: window.through },
        )
        .orderBy("st.nextDueDate", "ASC");

      // The stored sign selects the outflows only where nothing can move it.
      //
      // For a plain or ordinary-split schedule with no override the effective
      // amount IS the stored one, so `st.amount < 0` is exactly the set of
      // outflows and narrowing here saves resolving every positive schedule.
      // Two things can move that sign, and both keep their rows in the candidate
      // set whatever the snapshot says:
      //
      //  - an FX-sensitive schedule (a top-level investment, or a split parent
      //    carrying an investment line) has its cash total recomputed, and for a
      //    mixed-sign parent that can land on the other side of zero;
      //  - a per-occurrence override REPLACES the amount outright, sign included,
      //    so a schedule stored at +100 whose next occurrence is overridden to
      //    -250 is a genuine outflow the snapshot cannot see. An override can
      //    also replace the SHAPE: `is_split` with its own splits, an embedded
      //    investment among them, and `amount` left NULL because the lines carry
      //    it -- priced at the current rate that occurrence can be negative while
      //    the base is positive, which is why the predicate cannot ask about the
      //    amount alone. Only an override that carries neither an amount nor
      //    splits inherits the base entirely, and that one does not widen the
      //    read.
      //
      // The direction itself is decided on the resolved occurrence below.
      if (filter.outflowsOnly) {
        qb.andWhere(
          `(st.amount < 0 OR st.isInvestment = true OR EXISTS (
              SELECT 1 FROM scheduled_transaction_splits s
              WHERE s.scheduled_transaction_id = st.id
                AND s.kind = :investmentKind
                AND s.investment_action IS NOT NULL
            ) OR EXISTS (
              SELECT 1 FROM scheduled_transaction_overrides ovr
              WHERE ovr.scheduled_transaction_id = st.id
                AND (ovr.amount IS NOT NULL OR ovr.is_split = true)
            ))`,
          { investmentKind: SplitKind.INVESTMENT },
        );
      }
      // An auto-posted schedule needs no reminder -- the posting is the reminder.
      if (filter.manualOnly) {
        qb.andWhere("st.autoPost = :autoPost", { autoPost: false });
      }
      return qb.getMany();
    });

    if (!filter.outflowsOnly) return this.expand(userId, rows, window);

    // A cap is applied to what the caller ASKED for, so it has to come after the
    // direction filter, not before it.
    //
    // `maxOccurrences` is applied inside the expander, by due date. Expanding with
    // the cap and filtering afterwards silently answered "no upcoming rent" for a
    // schedule whose nearest occurrence had been overridden into a credit: the cap
    // kept that one occurrence, the direction filter then dropped it, and the real
    // -1,500 outflow later in the same period never reached the budget. So the
    // expansion runs uncapped, the direction decides, and the cap is applied per
    // schedule at the end -- the order the caller means.
    const occurrences = await this.expand(userId, rows, {
      ...window,
      maxOccurrences: undefined,
    });
    // An unknown direction is KEPT, not dropped: its amount is unknown too, so a
    // consumer's total is withheld either way, and dropping it would hide a
    // possible outflow behind a total that still looked complete.
    const outflows = occurrences.filter(
      (o) => o.directionAmount === null || o.directionAmount < 0,
    );
    if (window.maxOccurrences === undefined) return outflows;

    const kept: ResolvedScheduledOccurrence[] = [];
    const perSchedule = new Map<string, number>();
    // `expand` returns due-date order, so taking the first N per schedule keeps
    // each schedule's own earliest occurrences.
    for (const occurrence of outflows) {
      const seen = perSchedule.get(occurrence.scheduledTransactionId) ?? 0;
      if (seen >= window.maxOccurrences) continue;
      perSchedule.set(occurrence.scheduledTransactionId, seen + 1);
      kept.push(occurrence);
    }
    return kept;
  }

  /**
   * A loan bill's occurrences after the next, each at its own due date
   * (spec 8.7, INV-OCCURRENCE-003, INV-LOAN-009).
   *
   * The template is the next installment's bill, not every installment's:
   * the debt falls, the rate and the dated payment change, so "what this
   * occurrence would post today" for a later loan occurrence is what posting
   * it would move once the slots before it have posted, which is the
   * projection's amount (spec section 8). The cursor keeps the answer above,
   * which is what posting it today moves; so does any occurrence due beyond
   * `LOAN_OCCURRENCE_HORIZON_DAYS`, and any schedule the projection does not
   * price (`not-a-loan`, `declined`).
   *
   * A projected occurrence whose amount is unknown (no rate at its date, an
   * earlier one unknown, the ledger unreadable) is reported unknown, never as
   * the template; its direction stays the template's, which no rate moves.
   */
  private async priceLoanOccurrences(
    userId: string,
    occurrences: ResolvedScheduledOccurrence[],
    overridesBySchedule: Map<string, ScheduledTransactionOverride[]>,
  ): Promise<ResolvedScheduledOccurrence[]> {
    const horizon = addDaysYMD(todayYMD(), LOAN_OCCURRENCE_HORIZON_DAYS);
    const projected = (o: ResolvedScheduledOccurrence): boolean =>
      o.schedule.isActive !== false &&
      o.dueDate <= horizon &&
      o.originalDate !== ensureYMD(o.schedule.nextDueDate) &&
      // A loan bill is a split template with a transfer line into the loan;
      // anything else is not one, and is not read again to find that out.
      (o.schedule.splits ?? []).some((split) => !!split.transferAccountId);

    const candidates = new Map<string, ScheduledTransaction>();
    for (const occurrence of occurrences) {
      if (projected(occurrence)) {
        candidates.set(occurrence.scheduledTransactionId, occurrence.schedule);
      }
    }
    if (candidates.size === 0) return occurrences;

    // The projection walks from the cursor, so it is asked for every
    // occurrence from there through the last date this expansion prices,
    // whatever lower bound the caller's window had.
    const requests = [...candidates.values()].map((schedule) => {
      const through = occurrences
        .filter((o) => o.scheduledTransactionId === schedule.id && projected(o))
        .reduce((last, o) => (o.dueDate > last ? o.dueDate : last), "");
      return {
        scheduledTransactionId: schedule.id,
        count: expandOccurrenceSlots(
          schedule,
          overridesBySchedule.get(schedule.id) ?? [],
          { through },
        ).length,
      };
    });
    const projections = await this.loanService.projectLoanOccurrencesMany(
      userId,
      requests,
    );

    return occurrences.flatMap((occurrence) => {
      if (!projected(occurrence)) return [occurrence];
      const projection = projections.get(occurrence.scheduledTransactionId);
      const priced = withLoanAmount(occurrence, projection);
      return priced === null ? [] : [priced];
    });
  }

  private async loadOverrides(
    scheduleIds: string[],
  ): Promise<Map<string, ScheduledTransactionOverride[]>> {
    const overrides = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).find({
        where: { scheduledTransactionId: In(scheduleIds) },
      }),
    );
    const bySchedule = new Map<string, ScheduledTransactionOverride[]>();
    for (const override of overrides) {
      const list = bySchedule.get(override.scheduledTransactionId) ?? [];
      list.push(override);
      bySchedule.set(override.scheduledTransactionId, list);
    }
    return bySchedule;
  }
}

/**
 * One occurrence with its projected loan amount, or `null` for an occurrence
 * that never posts. `projection` is `null` when the loan's ledger could not
 * be read, so every projected figure is unknown.
 */
function withLoanAmount(
  occurrence: ResolvedScheduledOccurrence,
  projection: LoanOccurrencesProjection | null | undefined,
): ResolvedScheduledOccurrence | null {
  if (projection === undefined) return occurrence;
  if (projection !== null && projection.status !== "priced") return occurrence;
  const rows = projection?.occurrences ?? [];
  const row = rows.find((o) => o.originalDate === occurrence.originalDate);
  if (projection !== null && row === undefined) {
    // The projection ends before a slot by which the debt is settled (8.2):
    // the advancement deactivates the schedule, so that occurrence never
    // posts and is not listed. Any other gap (the schedule moved between the
    // two reads) leaves the occurrence as it was.
    const lastSlot = rows.reduce(
      (last, o) => (o.originalDate > last ? o.originalDate : last),
      "",
    );
    return lastSlot !== "" && occurrence.originalDate > lastSlot
      ? null
      : occurrence;
  }
  // The template's sign is the bill's direction; the projection is unsigned.
  const snapshot = Number(occurrence.schedule.amount);
  const sign = snapshot > 0 ? 1 : -1;
  const amount = row?.amount ?? null;
  if (amount === null) {
    return {
      ...occurrence,
      amount: null,
      directionAmount: snapshot,
      complete: false,
    };
  }
  const signed = amount === 0 ? 0 : sign * amount;
  return {
    ...occurrence,
    amount: signed,
    directionAmount: signed,
    complete: true,
  };
}
