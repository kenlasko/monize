import { BadRequestException, Logger } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { tr } from "../i18n/translate";
// One-way dependency: `loan-installments/` must never import this file back.
import { identifyLoanTemplate } from "../loan-installments/price-installment";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { Account } from "./entities/account.entity";
import { LoanFee } from "../loan-fees/entities/loan-fee.entity";

const logger = new Logger("LoanInterestCategory");

/**
 * Refuse an interest category the caller does not own. Runs inside the
 * caller's transaction, before anything is written, so a refused create or
 * update leaves no row behind.
 */
export async function assertLoanInterestCategory(
  m: EntityManager,
  userId: string,
  categoryId: string,
): Promise<void> {
  const category = await m.getRepository(Category).findOne({
    where: { id: categoryId, userId },
  });
  if (!category) {
    throw new BadRequestException(
      tr(
        "errors.accounts.invalidInterestCategory",
        "Choose one of your own categories for the interest portion of the payment",
      ),
    );
  }
}

export type LoanInterestRelinkPlan =
  | { kind: "relink"; split: ScheduledTransactionSplit; next: string }
  | { kind: "noop"; reason: string };

/**
 * Decide what a change of a loan's interest category does to its payment
 * template's interest line (INV-LOAN-010). Reads and locks, writes nothing:
 * the caller saves the account, then applies a relink with
 * `applyLoanInterestRelink` in the same transaction.
 *
 * - Relink: exactly one candidate line (a category line with no transfer
 *   whose category is NULL or the previous interest category, or the line a
 *   managed template already prices as interest), and the template is
 *   managed with that line carrying the new category.
 * - No-op: the category was cleared, the loan has no schedule, or there is no
 *   single candidate whose relink yields a managed template. Lines are never
 *   guessed: an escrow, insurance or tax line is not marked as interest.
 * - Refuse: a template managed under the previous category would not be
 *   managed after the change. Thrown before anything is written.
 *
 * The caller holds the loan's account row lock; the schedule row is locked
 * next, the order `reassignLoanSourceAccount` and the template repricing take.
 */
export async function planLoanInterestRelink(
  m: EntityManager,
  userId: string,
  loan: Pick<Account, "id" | "scheduledTransactionId">,
  previous: string | null,
  next: string | null,
): Promise<LoanInterestRelinkPlan> {
  if (next === null) {
    return noop(loan, previous, next, "category cleared");
  }
  // A fee's line is identified by its category (docs/specs/mortgage-fees.md
  // section 2), so the interest category cannot be one a fee holds: the two
  // lines would be one category, and which is interest a guess.
  const fees = await m.getRepository(LoanFee).find({
    where: { accountId: loan.id },
  });
  if (fees.some((fee) => fee.categoryId === next)) {
    throw new BadRequestException(
      tr(
        "errors.accounts.interestCategoryIsLoanFee",
        "This category is already used by one of the mortgage's fees. Choose another category for the interest, or change the fee first.",
      ),
    );
  }
  if (!loan.scheduledTransactionId) {
    return noop(loan, previous, next, "no linked schedule");
  }
  const schedule = await m.getRepository(ScheduledTransaction).findOne({
    where: { id: loan.scheduledTransactionId, userId },
    lock: { mode: "pessimistic_write" },
  });
  if (!schedule) {
    return noop(loan, previous, next, "no linked schedule");
  }
  const splits = await m.getRepository(ScheduledTransactionSplit).find({
    where: { scheduledTransactionId: schedule.id },
  });

  const before = identifyLoanTemplate(
    splits,
    { id: loan.id, interestCategoryId: previous },
    fees,
  );
  const candidates = splits.filter(
    (s) =>
      s.kind === SplitKind.CATEGORY &&
      !s.transferAccountId &&
      (s.categoryId === null ||
        s.categoryId === previous ||
        (before.managed && s === before.interestSplit)),
  );

  let relinked: ScheduledTransactionSplit | null = null;
  let reason: string;
  if (candidates.length === 1) {
    const [candidate] = candidates;
    const after = splits.map((s) =>
      s === candidate ? { ...s, categoryId: next } : s,
    );
    if (
      identifyLoanTemplate(
        after,
        { id: loan.id, interestCategoryId: next },
        fees,
      ).managed
    ) {
      relinked = candidate;
      reason = "single candidate line";
    } else {
      reason = "template not managed even with the line relinked";
    }
  } else {
    reason = `${candidates.length} candidate lines`;
  }

  // The guarantee: a template managed before a successful update is managed
  // after it. With the candidate rule above this does not occur; it is the
  // check that keeps a future change to either rule from breaking it.
  if (before.managed && !relinked) {
    logger.warn(
      `Refused interest category change on loan ${loan.id}: ${reason}; the payment template would stop being managed`,
    );
    throw new BadRequestException(
      tr(
        "errors.accounts.interestCategoryBreaksTemplate",
        "This loan's scheduled payment could not be moved to the new interest category. Edit the scheduled payment's interest line first.",
      ),
    );
  }
  if (!relinked) {
    return noop(loan, previous, next, reason);
  }
  logger.log(
    `Relinking interest line of schedule ${schedule.id} for loan ${loan.id}: ${previous ?? "none"} -> ${next}`,
  );
  return { kind: "relink", split: relinked, next };
}

/** Write a planned relink: only the line's category; no amount changes. */
export async function applyLoanInterestRelink(
  m: EntityManager,
  plan: LoanInterestRelinkPlan,
): Promise<void> {
  if (plan.kind !== "relink") return;
  plan.split.categoryId = plan.next;
  await m.getRepository(ScheduledTransactionSplit).save(plan.split);
}

function noop(
  loan: Pick<Account, "id">,
  previous: string | null,
  next: string | null,
  reason: string,
): LoanInterestRelinkPlan {
  logger.log(
    `Interest category of loan ${loan.id} changed (${previous ?? "none"} -> ${next ?? "none"}); payment template left as is: ${reason}`,
  );
  return { kind: "noop", reason };
}
