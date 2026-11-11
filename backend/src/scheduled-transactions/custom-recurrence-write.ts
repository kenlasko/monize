import { BadRequestException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import {
  CustomRecurrence,
  isCustomDate,
  nextCustomDate,
  normalizeCustomRecurrence,
} from "../common/custom-recurrence";
import { FrequencyType, ensureYMD } from "../common/recurrence";
import { addDaysYMD } from "../common/date-utils";
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
 * it, the rule's periods still counted from `startDate` (section 5). Never
 * `firstCustomDate(startDate)`: on a schedule that has been running that is a
 * date behind the cursor, which would hand back occurrences already settled.
 */
export function snapToCustomPattern(
  nextDueDate: string,
  startDate: string,
  rule: CustomRecurrence,
): string {
  const next = ensureYMD(nextDueDate);
  const start = ensureYMD(startDate);
  if (isCustomDate(next, rule, start)) return next;
  return nextCustomDate(addDaysYMD(next, -1), rule, start);
}

/** The schedule columns an orphan check expands. */
export interface OrphanCheckSchedule {
  frequency: FrequencyType;
  nextDueDate: string;
  startDate: string;
  customRecurrence: CustomRecurrence | null;
}

/**
 * The overrides at or after the cursor whose `originalDate` is not a slot of
 * `schedule` (section 5, "Edited occurrences that no longer fit"). Slots come
 * from the one expander, walked to the last such override and no further than
 * `OCCURRENCE_WALK_GUARD` steps; an override beyond a walk the guard cut short
 * is kept, because nothing proved it orphaned. The end date and the remaining
 * count are not consulted: this answers whether the pattern still holds the
 * slot, and an end-date edit is not a pattern change.
 */
export function orphanedOverrides<O extends { originalDate: string | Date }>(
  schedule: OrphanCheckSchedule,
  overrides: readonly O[],
): O[] {
  const cursor = ensureYMD(schedule.nextDueDate);
  const future = overrides.filter(
    (o) => ensureYMD(o.originalDate as string) >= cursor,
  );
  if (future.length === 0) return [];
  const through = future
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
  return future.filter((o) => {
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
