import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { Account } from "../accounts/entities/account.entity";
import { ensureYMD } from "../common/recurrence";
import { addDaysYMD } from "../common/date-utils";
import {
  LoanOccurrence,
  loanProjectionOccurrences,
  projectLoanOccurrences,
} from "../loan-installments/project-loan-occurrences";
import { bookLoanAllocation } from "../accounts/loan-payment-waterfall.util";
import {
  bookSplitsAtMinorUnit,
  currencyMinorUnitDecimals,
  LOAN_LIKE_ACCOUNT_TYPES,
  minorUnitAbsorbIndex,
} from "../common/currency-minor-unit.util";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import {
  datedLoanDebt,
  datedLoanDebts,
} from "../accounts/dated-loan-debt.util";
import {
  findLoanAccount,
  InstallmentPurpose,
  resolveInstallmentCore,
  ResolvedInstallment,
} from "../loan-installments/price-installment";
import {
  rewriteLoanTemplate,
  TemplateRewritePurpose,
} from "../loan-installments/reprice-template";

// The account types that carry a scheduled loan-payment structure and therefore
// need their next principal/interest split advanced after each posting. This set
// must stay in step with what `LoanPaymentSetupService` accepts when it creates
// that structure -- it accepts LOAN, MORTGAGE and LINE_OF_CREDIT, so a LOC left
// out of the recalculation would keep billing the first installment's split
// forever (issue #1154 re-review).
// The list itself is `LOAN_LIKE_ACCOUNT_TYPES` in
// `common/currency-minor-unit.util.ts`, shared with the minor-unit booking.

/*
 * The pricing itself -- `InstallmentPurpose`, `ResolvedInstallment`, the
 * dated rate, the method principal and the waterfall -- lives in
 * `backend/src/loan-installments/price-installment.ts`, and the template
 * rewrite in `reprice-template.ts` beside it, so the settlement of a bank
 * debit (`docs/specs/loan-installment-settlement.md`) prices through the same
 * code without importing this service. This class is the Nest door to that
 * module for the scheduled-transaction paths: it opens the transaction and
 * keeps the posting path's defaults.
 */

/** The effective split amounts a posting should write, keyed by scheduled-split id. */
export interface LoanPostingAllocation {
  /** Signed amounts (negative = payment out of the source account). */
  amountsBySplitId: Map<string, number>;
  /** Signed parent amount matching the sum of the managed children. */
  parentAmount: number;
}

/**
 * What a posting should do with a loan template.
 *
 * Three answers, not two. Collapsing `retired` into "not applicable" is how a
 * fully paid-off loan went on charging its whole stale installment: the posting
 * read `null` as "this is not a managed loan template, use the persisted
 * amounts" and wrote the last bill it happened to hold -- interest against a
 * debt that no longer exists, and principal that pushes the account into
 * credit. "There is nothing to price here" and "the price is zero" are
 * different instructions.
 */
export type LoanPostingDecision =
  /** Not a managed loan template -- post the persisted amounts, as before. */
  | { kind: "not-applicable" }
  /** A managed template whose debt is already retired: post no money. */
  | { kind: "retired" }
  | ({ kind: "allocation" } & LoanPostingAllocation);

/**
 * The answer of `GET /scheduled-transactions/:id/loan-occurrences`
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 8.1).
 * `occurrences` is empty unless `status` is `priced`; for the other two the
 * client shows what the posting will move, which is the snapshot
 * `ScheduledOccurrenceService` already answers.
 */
export interface LoanOccurrencesProjection {
  scheduledTransactionId: string;
  loanAccountId: string | null;
  /**
   * `not-a-loan`: no transfer into a loan-like account; `declined`: a shape
   * the core does not price, or a foreign-currency schedule, which the
   * posting does not re-price either.
   */
  status: "priced" | "not-a-loan" | "declined";
  currencyCode: string;
  occurrences: LoanOccurrence[];
}

/**
 * How far past the cursor the recurrence may be walked for a projection: a
 * runaway bound, not a horizon. The count bounds the result, and the walk
 * stops once that many occurrences are settled (`expandOccurrenceSlots`), so
 * only a schedule with fewer occurrences left than asked for reaches this.
 */
const LOAN_PROJECTION_WALK_DAYS = 36_525;

@Injectable()
export class ScheduledTransactionLoanService {
  constructor(private dataSource: DataSource) {}

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
  ): Promise<void> {
    return this.rewriteTemplate(scheduledTransactionId, "template");
  }

  /**
   * Reprice a loan template after its mortgage's amortization method changed
   * (docs/specs/mortgage-types.md, section 5.6): to the method's installment
   * for LINEAR and INTEREST_ONLY, and to the account's new constant payment for
   * an annuity type. Called by the account update in the same transaction as
   * the type change, after the account row is written and locked (accounts
   * before scheduled transactions, `docs/concurrency-and-idempotency.md`
   * section 5).
   */
  async repriceLoanTemplate(scheduledTransactionId: string): Promise<void> {
    return this.rewriteTemplate(scheduledTransactionId, "reconfigure");
  }

  private async rewriteTemplate(
    scheduledTransactionId: string,
    purpose: TemplateRewritePurpose,
  ): Promise<void> {
    return withScopedDb(this.dataSource, (m) =>
      rewriteLoanTemplate(m, scheduledTransactionId, purpose),
    );
  }

  /**
   * The effective principal/interest allocation for the occurrence about to be
   * posted, derived from the ledger at the consumption boundary.
   *
   * The stored split is a template computed when the *previous* occurrence
   * posted; any principal movement committed since (a standalone overpayment, a
   * void, an import) leaves it stale, and no mutation path recalculates it. So
   * the posting path calls this immediately before writing the financial
   * transaction -- inside the same scoped transaction and under the same parent
   * lock -- and posts these amounts instead of the persisted ones. When nothing
   * moved in between, this resolves to exactly what the template already holds.
   *
   * `asOfDate` is the date this occurrence's money actually moves -- the
   * posting date, which an override can move off the recurrence slot -- because
   * that is the date the interest accrues to.
   *
   * The total is the bill the user was shown: this re-divides it between
   * interest and principal and never resizes it (see `InstallmentPurpose`).
   * It is booked in the currency's smallest unit (`bookLoanAllocation`): the
   * bill shows 1,170.65 for a 1,170.6458 installment, and 1,170.65 is what
   * the bank debits (issue #1581).
   *
   * The decision distinguishes three outcomes, because two of them used to
   * share `null` and a retired loan therefore went on charging its whole stale
   * installment:
   *
   *  - `not-applicable` -- the split set is not a managed loan template, or its
   *    shape is one the recalculation would also decline. The posting proceeds
   *    on the persisted amounts, which is today's behavior.
   *  - `retired` -- it IS a managed template and the debt through `asOfDate` is
   *    already settled, so the correct price is zero: the occurrence is claimed
   *    and the schedule advances, and no financial transaction is written.
   *  - `allocation` -- the interest/principal split to post.
   *
   * **Throws when the ledger cannot be read.** That is not "this is not a loan
   * template": silently declining there would post the stale stored split,
   * which is the exact defect this method exists to prevent, so the occurrence
   * refuses and the whole posting transaction rolls back rather than committing
   * a figure nothing verified.
   */
  async resolvePostingAllocation(
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
    asOfDate: string,
  ): Promise<LoanPostingDecision> {
    return withScopedDb(this.dataSource, async (m) => {
      const loanAccount = await findLoanAccount(m, splits);
      if (!loanAccount) {
        return { kind: "not-applicable" } as const;
      }

      const installment = await this.resolveInstallment(
        m,
        scheduledTransaction,
        splits,
        loanAccount,
        asOfDate,
        "posting",
      );
      if (installment.kind === "paid-off") {
        // Only a template whose every line this service accounts for. An
        // escrow or tax line is still owed when the mortgage principal reaches
        // zero, so that bill posts as it always has.
        return installment.managed
          ? ({ kind: "retired" } as const)
          : ({ kind: "not-applicable" } as const);
      }
      if (installment.kind === "unreadable") {
        throw new ServiceUnavailableException(
          tr(
            "errors.scheduled.loanLedgerUnreadable",
            "This loan payment could not be priced because its ledger balance could not be read. Try again.",
          ),
        );
      }
      if (installment.kind !== "ok") {
        return { kind: "not-applicable" } as const;
      }

      // Priced at storage precision, booked in the currency's smallest unit:
      // the account this debits moves whole cents (issue #1581). The posting
      // path excludes a foreign-currency schedule, so the schedule's currency
      // is the source account's.
      const allocation = bookLoanAllocation(
        installment.allocation,
        currencyMinorUnitDecimals(scheduledTransaction.currencyCode),
        installment.debt,
      );
      const { template } = installment;
      const amountsBySplitId = new Map<string, number>();
      if (template.principalSplit?.id) {
        amountsBySplitId.set(template.principalSplit.id, -allocation.principal);
      }
      if (template.interestSplit.id) {
        amountsBySplitId.set(template.interestSplit.id, -allocation.interest);
      }
      if (template.extraPrincipalSplit?.id) {
        amountsBySplitId.set(
          template.extraPrincipalSplit.id,
          -allocation.extraPrincipal,
        );
      }
      return {
        kind: "allocation" as const,
        amountsBySplitId,
        parentAmount: -allocation.total,
      };
    });
  }

  /**
   * The stored template booked in the currency's smallest unit: every line and
   * the parent rounded to it, the rounding difference on the loan's principal
   * line, or on the largest line of a split set that pays no loan
   * (`bookSplitsAtMinorUnit` and `minorUnitAbsorbIndex`, mirrored by the
   * client). It is what the Post dialog pre-fills, so the posting path
   * compares the dialog's lines with it to tell an unchanged echo, which
   * re-prices from the ledger, from figures the user typed, which post as
   * given; and it is what an automatic posting books when the template is not
   * one the loan pricing re-divides (issue #1581).
   */
  async bookTemplateAtMinorUnit(
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
  ): Promise<LoanPostingAllocation> {
    return withScopedDb(this.dataSource, async (m) => {
      const accountTypeById = new Map<string, string>();
      for (const split of splits) {
        const accountId = split.transferAccountId;
        if (!accountId || accountTypeById.has(accountId)) continue;
        const account = await m
          .getRepository(Account)
          .findOne({ where: { id: accountId } });
        if (account) accountTypeById.set(account.id, account.accountType);
      }
      const booked = bookSplitsAtMinorUnit(
        splits.map((s) => Number(s.amount)),
        Number(scheduledTransaction.amount),
        currencyMinorUnitDecimals(scheduledTransaction.currencyCode),
        minorUnitAbsorbIndex(splits, accountTypeById),
      );
      const amountsBySplitId = new Map<string, number>();
      splits.forEach((s, index) => {
        if (s.id) amountsBySplitId.set(s.id, booked.amounts[index]);
      });
      return { amountsBySplitId, parentAmount: booked.parentAmount };
    });
  }

  /**
   * The authoritative anchor for projecting this loan's amortization forward:
   * the next scheduled installment's due date, and the debt measured from the
   * ledger through that date -- the same boundary the scheduled bill's own
   * interest is calculated from, so the two price the same BALANCE (issue
   * #1253).
   *
   * The RATE is shared too: `datedAnnualRate` resolves it from the same
   * `loan_rate_changes` timeline the report reads, against a truth table both
   * layers assert. Neither input is the account's scalar unless the timeline
   * says nothing.
   *
   * `nextDueDate`/`debt` are null when the loan has no active scheduled payment
   * transferring to it; a projection then has no bill to be in parity with and
   * anchors at today, which the caller keeps as its fallback.
   */
  async getLoanProjectionAnchor(
    userId: string,
    loanAccountId: string,
  ): Promise<{ nextDueDate: string | null; debt: number | null }> {
    return withScopedDb(this.dataSource, async (m) => {
      const loanAccount = await m.getRepository(Account).findOne({
        where: { id: loanAccountId, userId },
      });
      if (
        !loanAccount ||
        !LOAN_LIKE_ACCOUNT_TYPES.has(loanAccount.accountType)
      ) {
        return { nextDueDate: null, debt: null };
      }

      // WHICH schedule is the loan's payment is the account's own statement:
      // `accounts.scheduled_transaction_id` is written by the two paths that
      // set a loan payment up, and INV-LOAN-005's migration relies on the same
      // pointer. Reaching instead for "any active schedule with a transfer
      // split into this loan" answers a different question -- a standalone
      // extra-principal transfer is an ordinary configuration and, due sooner,
      // would win the ORDER BY and anchor the report on an installment no bill
      // will ever post.
      //
      // The fallback covers a loan whose pointer was never written (an older
      // setup, an imported account): a schedule naming the loan as a transfer
      // target, by its top-level column OR by a split -- both spellings,
      // because a plain scheduled transfer into the loan carries no split and
      // the balance forecast already counts it.
      //
      // The date is the one the occurrence FALLS ON, so an override that moved
      // it off its recurrence slot moves the anchor with it -- the posting
      // prices at `postDate` for exactly that reason, and an anchor left on the
      // abandoned slot would put the report back into disagreement with the
      // bill it is supposed to match. The ordering stays on the slot, which is
      // what makes "the next one" well defined.
      const scheduleRows: Array<{ next_due_date: string }> = await m.query(
        `SELECT TO_CHAR(
                  COALESCE(ovr.override_date, st.next_due_date), 'YYYY-MM-DD'
                ) AS next_due_date
           FROM scheduled_transactions st
           LEFT JOIN scheduled_transaction_overrides ovr
             ON ovr.scheduled_transaction_id = st.id
            AND ovr.original_date = st.next_due_date
          WHERE st.user_id = $1
            AND st.is_active = true
            AND (
              st.id = $3::uuid
              OR ($3::uuid IS NULL AND (
                st.transfer_account_id = $2
                OR EXISTS (
                  SELECT 1 FROM scheduled_transaction_splits sts
                   WHERE sts.scheduled_transaction_id = st.id
                     AND sts.transfer_account_id = $2
                )
              ))
            )
          ORDER BY st.next_due_date ASC
          LIMIT 1`,
        [userId, loanAccountId, loanAccount.scheduledTransactionId ?? null],
      );
      const nextDueDate = scheduleRows[0]?.next_due_date ?? null;
      if (!nextDueDate) {
        return { nextDueDate: null, debt: null };
      }

      const debt = await datedLoanDebt(m, loanAccount, nextDueDate);
      if (debt === null) {
        // "The ledger could not be read" is not "this loan has no scheduled
        // payment" -- the caller reads the second as licence to project from
        // today's balance, which is the drift this endpoint exists to close.
        throw new ServiceUnavailableException(
          tr(
            "errors.accounts.loanLedgerUnreadable",
            "This loan's balance could not be read. Try again.",
          ),
        );
      }
      return { nextDueDate, debt };
    });
  }

  /**
   * The next `count` occurrences of a loan bill, each priced at its own due
   * date (spec section 8): identity from `expandOccurrenceSlots`, the ledger
   * debt at every date in one statement, the timeline in one read, and the
   * fold of `projectLoanOccurrences` over them. Nothing is locked: this is a
   * read, and what the posting books is decided at the posting boundary.
   *
   * A schedule that is not the caller's is not found; one that transfers to
   * no loan-like account answers `not-a-loan`; an inactive one has no
   * occurrence to price and answers an empty list. **Throws when the ledger
   * cannot be read** (8.4): a projected figure a default stood in for would
   * be a guess the reader cannot tell from a fact.
   */
  async projectLoanOccurrences(
    userId: string,
    scheduledTransactionId: string,
    count: number,
  ): Promise<LoanOccurrencesProjection> {
    const projection = await withScopedDb(this.dataSource, (m) =>
      this.projectWithin(m, userId, scheduledTransactionId, count),
    );
    if (projection === null) {
      throw new ServiceUnavailableException(
        tr(
          "errors.scheduled.loanLedgerUnreadable",
          "This loan payment could not be priced because its ledger balance could not be read. Try again.",
        ),
      );
    }
    return projection;
  }

  /**
   * `projectLoanOccurrences` for several schedules in one transaction, for
   * `ScheduledOccurrenceService` (spec 8.7). A schedule whose ledger cannot
   * be read answers `null` rather than failing the read: one loan's unknown
   * figures are that loan's, and the bills, budgets and forecasts beside it
   * still have theirs. The caller reports that schedule's projected
   * occurrences as unknown, never as the template.
   */
  async projectLoanOccurrencesMany(
    userId: string,
    requests: ReadonlyArray<{ scheduledTransactionId: string; count: number }>,
  ): Promise<Map<string, LoanOccurrencesProjection | null>> {
    const projections = new Map<string, LoanOccurrencesProjection | null>();
    if (requests.length === 0) return projections;
    await withScopedDb(this.dataSource, async (m) => {
      for (const { scheduledTransactionId, count } of requests) {
        projections.set(
          scheduledTransactionId,
          await this.projectWithin(m, userId, scheduledTransactionId, count),
        );
      }
    });
    return projections;
  }

  /** The body of both projections; `null` when the ledger cannot be read (8.4). */
  private async projectWithin(
    m: EntityManager,
    userId: string,
    scheduledTransactionId: string,
    count: number,
  ): Promise<LoanOccurrencesProjection | null> {
    const schedule = await m
      .getRepository(ScheduledTransaction)
      .findOne({ where: { id: scheduledTransactionId, userId } });
    if (!schedule) {
      throw new NotFoundException(
        tr(
          "errors.scheduled.notFound",
          `Scheduled transaction with ID ${scheduledTransactionId} not found`,
          { id: scheduledTransactionId },
        ),
      );
    }
    const splits = await m
      .getRepository(ScheduledTransactionSplit)
      .find({ where: { scheduledTransactionId } });
    const loanAccount = await findLoanAccount(m, splits);
    if (!loanAccount) {
      return {
        scheduledTransactionId,
        loanAccountId: null,
        status: "not-a-loan" as const,
        currencyCode: schedule.currencyCode ?? "",
        occurrences: [],
      };
    }
    const currencyCode = schedule.currencyCode ?? loanAccount.currencyCode;
    // `post()` posts a foreign-currency schedule's converted amounts and
    // never re-prices them (its `!fx` gate), so a figure priced here would
    // be one the posting does not move. The snapshot answers it.
    if (schedule.originalCurrencyCode && schedule.originalAmount !== null) {
      return {
        scheduledTransactionId,
        loanAccountId: loanAccount.id,
        status: "declined" as const,
        currencyCode,
        occurrences: [],
      };
    }

    // Identity is the one expander's (INV-OCCURRENCE-003): the slots from
    // the cursor, each matched to its override, ordered by the date it
    // falls on, the first `count` of them.
    const overrides = schedule.isActive
      ? await m
          .getRepository(ScheduledTransactionOverride)
          .find({ where: { scheduledTransactionId } })
      : [];
    const occurrences = schedule.isActive
      ? loanProjectionOccurrences(
          schedule,
          overrides,
          count,
          addDaysYMD(
            ensureYMD(schedule.nextDueDate),
            LOAN_PROJECTION_WALK_DAYS,
          ),
        )
      : [];

    const rateChanges = await m.getRepository(LoanRateChange).find({
      where: { accountId: loanAccount.id },
      order: { effectiveDate: "ASC" },
    });
    // Both dates of every occurrence: the slot prices the template chain,
    // the date it falls on prices its lines (8.2).
    const debtLedger = await datedLoanDebts(
      m,
      loanAccount,
      occurrences.flatMap((o) => [o.originalDate, o.dueDate]),
    );
    if (debtLedger === null) return null;

    const projection = projectLoanOccurrences({
      schedule,
      splits,
      loanAccount,
      rateChanges,
      occurrences,
      count,
      debtLedger,
    });
    return {
      scheduledTransactionId,
      loanAccountId: loanAccount.id,
      status: projection.status,
      currencyCode,
      occurrences: projection.occurrences,
    };
  }

  /**
   * Resolve one installment of a scheduled loan payment: identify the managed
   * template lines, measure the debt through `asOfDate` from the ledger, price
   * the interest at the periodic rate, and run the shared waterfall.
   *
   * Both the post-posting recalculation and the posting-boundary resolution
   * price through here, so the template and what actually posts cannot use
   * two different rules. The body is `resolveInstallmentCore`
   * (`backend/src/loan-installments/price-installment.ts`), which the
   * settlement planner shares; a rate nothing records stays 0 % on this
   * service's purposes, the posting path's historical default.
   */
  private resolveInstallment(
    m: EntityManager,
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
    loanAccount: Account,
    asOfDate: string,
    purpose: InstallmentPurpose,
  ): Promise<ResolvedInstallment> {
    return resolveInstallmentCore(m, {
      scheduledTransaction,
      splits,
      loanAccount,
      asOfDate,
      purpose,
    });
  }

  async findLoanAccountFromSplits(
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const account = await findLoanAccount(m, splits);
      return account ? account.id : null;
    });
  }
}
