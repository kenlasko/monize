import { BadRequestException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import {
  CustomRecurrence,
  customDateOnOrAfter,
  normalizeCustomRecurrence,
} from "../common/custom-recurrence";
import { FrequencyType, ensureYMD } from "../common/recurrence";
import {
  OCCURRENCE_WALK_GUARD,
  expandOccurrenceSlots,
} from "../common/scheduled-occurrences";
import { LOAN_LIKE_ACCOUNT_TYPES } from "../common/currency-minor-unit.util";
import { Account } from "../accounts/entities/account.entity";
import { PayrollDeductionRule } from "../payroll-deductions/entities/payroll-deduction-rule.entity";
import { tr } from "../i18n/translate";

/**
 * The write half of the Custom frequency (docs/specs/custom-recurrence.md
 * section 5): the pairing of `frequency` with `custom_recurrence`, the snap of
 * `next_due_date` onto the pattern, the schedules that may not be Custom, and
 * the overrides a pattern change orphans. Create and update both come through
 * here, so the two cannot disagree about what a valid Custom schedule is.
 */

/** Two rules are the same when their canonical forms are; `null` is no rule. */
export function sameCustomRecurrence(
  a: CustomRecurrence | null | undefined,
  b: CustomRecurrence | null | undefined,
): boolean {
  const left = a == null ? null : normalizeCustomRecurrence(a);
  const right = b == null ? null : normalizeCustomRecurrence(b);
  if (left === null || right === null) return left === right;
  if (!left.ok || !right.ok) return JSON.stringify(a) === JSON.stringify(b);
  return JSON.stringify(left.rule) === JSON.stringify(right.rule);
}

function invalidRule(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.scheduled.customRecurrenceInvalid",
      "The custom recurrence rule is not valid",
    ),
  );
}

function canonical(rule: unknown): CustomRecurrence {
  const result = normalizeCustomRecurrence(rule);
  if (!result.ok) throw invalidRule();
  return result.rule;
}

/**
 * The rule a write stores: the canonical form when `frequency` is `CUSTOM`,
 * `null` otherwise. `supplied` is the request's value (`undefined` when the key
 * was left out), `stored` the row's (`undefined` on a create).
 *
 * A Custom schedule without a rule is refused. A rule beside another frequency
 * is refused too, unless it is the stored rule sent back unchanged: a form
 * resends every field, so leaving Custom with the old rule still in the payload
 * is a change of frequency, which clears it, not a request to keep it.
 */
export function resolveCustomRecurrence(
  frequency: FrequencyType,
  supplied: CustomRecurrence | null | undefined,
  stored?: CustomRecurrence | null,
): CustomRecurrence | null {
  if (frequency === "CUSTOM") {
    const rule = supplied !== undefined ? supplied : (stored ?? null);
    if (rule === null) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.customRecurrenceRequired",
          "A custom frequency needs a recurrence rule",
        ),
      );
    }
    return canonical(rule);
  }
  if (supplied != null && !sameCustomRecurrence(supplied, stored)) {
    throw new BadRequestException(
      tr(
        "errors.scheduled.customRecurrenceOnlyForCustom",
        "A recurrence rule can only be set when the frequency is Custom",
      ),
    );
  }
  return null;
}

/**
 * `nextDueDate` when it falls on the rule, else the first rule date on or after
 * it, the rule's periods still counted from `startDate` (section 5). Never the
 * first rule date on or after `startDate`: on a schedule that has been running
 * that is a date behind the cursor, which would hand back occurrences already
 * settled.
 */
export function snapToCustomPattern(
  nextDueDate: string,
  startDate: string,
  rule: CustomRecurrence,
): string {
  return customDateOnOrAfter(
    ensureYMD(nextDueDate),
    rule,
    ensureYMD(startDate),
  );
}

/** The pattern columns of a stored schedule, as an update decides against them. */
export interface PatternBasis {
  frequency: FrequencyType;
  customRecurrence: CustomRecurrence | null;
  startDate: string | Date;
  nextDueDate: string | Date;
}

/** The pattern columns an update request may carry; `undefined` is "not sent". */
export interface PatternRequest {
  frequency?: FrequencyType;
  customRecurrence?: CustomRecurrence | null;
  startDate?: string | Date;
  nextDueDate?: string | Date;
}

export interface PatternUpdate {
  frequency: FrequencyType;
  /** The rule the row holds after the write: canonical while Custom, else `null`. */
  rule: CustomRecurrence | null;
  /**
   * The frequency, the rule or the start date changed (section 5). A start date
   * moves the slots of every frequency, not only Custom: a month-based step
   * reads its day from the start date (`anchorDayOf`), so a new start can
   * orphan a month-end override.
   */
  patternChanged: boolean;
  /** Columns to write beside the request's own; a key is present only when written. */
  fields: { customRecurrence?: CustomRecurrence | null; nextDueDate?: string };
}

/**
 * What an update does to the pattern, decided against `stored` because a form
 * resends every field. The caller decides it from the row it holds the lock on,
 * so a concurrent write between its first read and the lock cannot leave a
 * Custom row without a rule or a rule beside another frequency: whenever the
 * frequency is written, the rule is written with it. A changed rule or start
 * date of a Custom schedule puts the cursor back on the pattern.
 */
export function resolvePatternUpdate(
  request: PatternRequest,
  stored: PatternBasis,
): PatternUpdate {
  const frequency = request.frequency ?? stored.frequency;
  const rule = resolveCustomRecurrence(
    frequency,
    request.customRecurrence,
    stored.customRecurrence,
  );
  const ruleChanged = !sameCustomRecurrence(rule, stored.customRecurrence);
  const startChanged =
    request.startDate !== undefined &&
    ensureYMD(request.startDate) !== ensureYMD(stored.startDate);
  const fields: PatternUpdate["fields"] = {};
  if (request.frequency !== undefined || ruleChanged) {
    fields.customRecurrence = rule;
  }
  if (rule && (ruleChanged || startChanged)) {
    const snapped = snapToCustomPattern(
      ensureYMD(request.nextDueDate ?? stored.nextDueDate),
      ensureYMD(request.startDate ?? stored.startDate),
      rule,
    );
    if (
      request.nextDueDate !== undefined ||
      snapped !== ensureYMD(stored.nextDueDate)
    ) {
      fields.nextDueDate = snapped;
    }
  }
  return {
    frequency,
    rule,
    patternChanged:
      frequency !== stored.frequency || ruleChanged || startChanged,
    fields,
  };
}

/** The schedule columns an orphan check expands. */
export interface OrphanCheckSchedule {
  frequency: FrequencyType;
  nextDueDate: string;
  startDate: string;
  customRecurrence: CustomRecurrence | null;
  /** The cursor the row held before the update. */
  previousNextDueDate: string;
}

/**
 * The overrides a pattern change orphans (section 5, "Edited occurrences that
 * no longer fit"). Candidates are the overrides on or after the earlier of the
 * old and the new cursor; a candidate is an orphan when its `originalDate` is
 * not a slot of the new schedule walked from the new cursor, so one the update
 * left behind the cursor is one too. Slots come from the one expander, walked
 * to the last candidate and no further than `OCCURRENCE_WALK_GUARD` steps; a
 * candidate beyond a walk the guard cut short is kept, because nothing proved
 * it orphaned. The end date and the remaining count are not consulted: this
 * answers whether the pattern still holds the slot, and an end-date edit is
 * not a pattern change. The frontend's warning applies the same rule.
 */
export function orphanedOverrides<O extends { originalDate: string | Date }>(
  schedule: OrphanCheckSchedule,
  overrides: readonly O[],
): O[] {
  const cursor = ensureYMD(schedule.nextDueDate);
  const previous = ensureYMD(schedule.previousNextDueDate);
  const floor = previous < cursor ? previous : cursor;
  const candidates = overrides.filter(
    (o) => ensureYMD(o.originalDate as string) >= floor,
  );
  if (candidates.length === 0) return [];
  const through = candidates
    .map((o) => ensureYMD(o.originalDate as string))
    .reduce((last, d) => (d > last ? d : last), cursor);
  const slots = expandOccurrenceSlots(
    {
      frequency: schedule.frequency,
      nextDueDate: cursor,
      startDate: schedule.startDate,
      customRecurrence: schedule.customRecurrence,
      endDate: null,
      occurrencesRemaining: null,
    },
    [],
    { through },
  );
  const held = new Set(slots.map((s) => s.originalDate));
  const walkedThrough =
    slots.length >= OCCURRENCE_WALK_GUARD
      ? slots[slots.length - 1].originalDate
      : through;
  return candidates.filter((o) => {
    const date = ensureYMD(o.originalDate as string);
    return !held.has(date) && date <= walkedThrough;
  });
}

/**
 * Refuse `CUSTOM` on a schedule whose arithmetic assumes a fixed cadence
 * (section 5, "Not offered"; spec decision 3): a loan or mortgage payment --
 * the schedule an account's `scheduled_transaction_id` names, or a split that
 * transfers into a loan-like account, which is the template the installment
 * pricing reprices -- and a payroll bill, one with deduction rules. Runs inside
 * the write's transaction, before its first write.
 */
export async function assertCustomFrequencyAllowed(
  m: EntityManager,
  userId: string,
  schedule: {
    id: string | null;
    splitTransferAccountIds: readonly (string | null | undefined)[];
  },
): Promise<void> {
  const transferIds = [
    ...new Set(
      schedule.splitTransferAccountIds.filter((id): id is string => !!id),
    ),
  ];
  const isLoanPointer =
    schedule.id !== null &&
    (await m.getRepository(Account).count({
      where: { scheduledTransactionId: schedule.id, userId },
    })) > 0;
  const transfersIntoLoan =
    transferIds.length > 0 &&
    (
      await m.getRepository(Account).find({
        where: { id: In(transferIds) },
        select: { id: true, accountType: true },
      })
    ).some((account) => LOAN_LIKE_ACCOUNT_TYPES.has(account.accountType));
  if (isLoanPointer || transfersIntoLoan) {
    throw new BadRequestException(
      tr(
        "errors.scheduled.customNotForLoan",
        "A loan or mortgage payment cannot use a custom frequency; choose a fixed frequency",
      ),
    );
  }
  if (
    schedule.id !== null &&
    (await m.getRepository(PayrollDeductionRule).count({
      where: { scheduledTransactionId: schedule.id, userId },
    })) > 0
  ) {
    throw new BadRequestException(
      tr(
        "errors.scheduled.customNotForPayroll",
        "A payroll bill with deduction limits cannot use a custom frequency; choose a fixed frequency",
      ),
    );
  }
}
