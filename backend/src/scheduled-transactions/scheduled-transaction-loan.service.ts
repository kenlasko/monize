import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { PaymentFrequency } from "../accounts/loan-amortization.util";
import {
  getPeriodicRate,
  getMortgagePeriodsPerYear,
  MortgagePaymentFrequency,
} from "../accounts/mortgage-amortization.util";
import { getPeriodsPerYear } from "../accounts/loan-amortization.util";
import { roundMoney } from "../common/round.util";
import { allocateLoanPayment } from "../accounts/loan-payment-waterfall.util";
import { withScopedDb } from "../common/db/scoped-db";

// The account types that carry a scheduled loan-payment structure and therefore
// need their next principal/interest split advanced after each posting. This set
// must stay in step with what `LoanPaymentSetupService` accepts when it creates
// that structure -- it accepts LOAN, MORTGAGE and LINE_OF_CREDIT, so a LOC left
// out of the recalculation would keep billing the first installment's split
// forever (issue #1154 re-review).
const LOAN_LIKE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
]);

@Injectable()
export class ScheduledTransactionLoanService {
  private readonly logger = new Logger(ScheduledTransactionLoanService.name);

  constructor(private dataSource: DataSource) {}

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
  ): Promise<void> {
    return withScopedDb(this.dataSource, async (m) => {
      // This writer mutates the child split set, so it must serialize through
      // the same parent lock the posting path takes (issue #1154 re-review): a
      // recalculation that changed principal/interest without the lock could
      // land between a poster's split-set guard and its write, and because a
      // P/I reallocation leaves the parent total unchanged, the poster's own
      // parent lock would not have blocked it. Lock the parent, then read the
      // current child set and derive the loan from it -- never from a loan id
      // captured off a pre-lock snapshot.
      const scheduledTransaction = await m
        .getRepository(ScheduledTransaction)
        .findOne({
          where: { id: scheduledTransactionId },
          lock: { mode: "pessimistic_write" },
        });

      if (!scheduledTransaction || !scheduledTransaction.isActive) {
        return;
      }

      const splits = await m.getRepository(ScheduledTransactionSplit).find({
        where: { scheduledTransactionId },
      });

      let loanAccount: Account | null = null;
      for (const split of splits) {
        if (!split.transferAccountId) continue;
        const candidate = await m.getRepository(Account).findOne({
          where: { id: split.transferAccountId },
        });
        if (candidate && LOAN_LIKE_ACCOUNT_TYPES.has(candidate.accountType)) {
          loanAccount = candidate;
          break;
        }
      }

      if (!loanAccount) {
        return;
      }
      const loanAccountId = loanAccount.id;

      // `current_balance` intentionally excludes future-dated transactions.
      // Recalculation runs after the schedule advances, so measure the loan at
      // the next due date to include every payment already posted before then,
      // including principal-only payments.
      const balanceRows: Array<{ balance: string }> = await m.query(
        `SELECT COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
           FROM accounts a
           LEFT JOIN transactions t ON t.account_id = a.id
            AND (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date <= $3
          WHERE a.id = $1 AND a.user_id = $2
          GROUP BY a.id, a.opening_balance`,
        [loanAccountId, loanAccount.userId, scheduledTransaction.nextDueDate],
      );
      const signedBalance = Number(
        balanceRows[0]?.balance ?? loanAccount.currentBalance,
      );
      const currentBalance = Math.max(0, -signedBalance);

      if (currentBalance <= 0.01) {
        await m
          .getRepository(ScheduledTransaction)
          .update(scheduledTransactionId, { isActive: false });
        return;
      }

      const templateAmount = Math.abs(Number(scheduledTransaction.amount));
      const interestRate = Number(loanAccount.interestRate) || 0;
      const frequency = (loanAccount.paymentFrequency ||
        scheduledTransaction.frequency) as PaymentFrequency;

      // Identify splits: there may be a regular principal transfer, an interest
      // category split, and optionally a separate extra principal transfer.
      // Extra principal splits have memo "Extra Principal" and transfer to the
      // loan account. Regular principal also transfers to the loan account.
      const extraPrincipalSplit = splits.find(
        (s) =>
          s.transferAccountId === loanAccountId &&
          s.memo?.toLowerCase().includes("extra"),
      );
      const principalSplit = splits.find(
        (s) =>
          s.transferAccountId === loanAccountId && s !== extraPrincipalSplit,
      );
      const interestSplit = splits.find(
        (s) => s.categoryId && !s.transferAccountId,
      );

      // What the template holds is what was just posted -- including any clamp
      // a previous pass wrote for that one installment (a final payment, an
      // interest spike consuming the extra). Deriving the *configured* payment
      // from it therefore ratchets: the clamp becomes the configuration and
      // nothing can grow back, even after the balance is restored by a void or
      // an import (review #1131). The durable configuration lives on the
      // account (payment_amount / extra_payment_amount, kept in sync when the
      // user edits the schedule); the template only wins where it is larger,
      // which can only mean a user edit the account columns have not seen.
      const templateExtraAmount = extraPrincipalSplit
        ? Math.abs(Number(extraPrincipalSplit.amount))
        : 0;
      const paymentAmount = Math.max(
        templateAmount,
        Number(loanAccount.paymentAmount) || 0,
      );
      // The extra can only ride in an existing split row -- this recalculation
      // never creates one -- so without the row the configured extra is 0.
      const extraPrincipalAmount = extraPrincipalSplit
        ? Math.max(
            templateExtraAmount,
            Number(loanAccount.extraPaymentAmount) || 0,
          )
        : 0;
      const basePaymentAmount = paymentAmount - extraPrincipalAmount;

      const periodsPerYear =
        loanAccount.accountType === "MORTGAGE"
          ? getMortgagePeriodsPerYear(frequency as MortgagePaymentFrequency)
          : getPeriodsPerYear(frequency);

      const periodicRate =
        loanAccount.accountType === "MORTGAGE"
          ? getPeriodicRate(
              interestRate,
              periodsPerYear,
              loanAccount.isCanadianMortgage,
              loanAccount.isVariableRate,
            )
          : interestRate / 100 / periodsPerYear;

      let newInterest = roundMoney(currentBalance * periodicRate);
      let newPrincipal = roundMoney(basePaymentAmount - newInterest);
      if (newPrincipal < 0) newPrincipal = 0;

      // The clamp sequence -- interest-first across the whole installment
      // (recheck RR2-006, DR3-01), principal bounded by the debt with the
      // discretionary extra absorbing the shortfall (audit P5-008, FR-009) --
      // is `allocateLoanPayment`, shared with the first installment written by
      // `LoanPaymentSetupService` because the two must agree about what any
      // installment looks like.
      const allocation = allocateLoanPayment({
        paymentAmount,
        extraPrincipal: extraPrincipalAmount,
        interest: newInterest,
        principal: newPrincipal,
        currentBalance,
      });
      newInterest = allocation.interest;
      newPrincipal = allocation.principal;
      const finalExtraPrincipal = allocation.extraPrincipal;
      const requiredParentAmount = allocation.total;

      this.logger.log(
        `Recalculate loan splits: balance=${currentBalance}, rate=${interestRate}%, ` +
          `freq=${frequency}, basePayment=${basePaymentAmount}, ` +
          `extra=${extraPrincipalAmount} (final ${finalExtraPrincipal}), ` +
          `newPrincipal=${newPrincipal}, newInterest=${newInterest}, ` +
          `isMortgage=${loanAccount.accountType === "MORTGAGE"}, ` +
          `isCanadian=${loanAccount.isCanadianMortgage}`,
      );

      if (principalSplit) {
        principalSplit.amount = -newPrincipal;
        await m.getRepository(ScheduledTransactionSplit).save(principalSplit);
      }

      if (interestSplit) {
        interestSplit.amount = -newInterest;
        await m.getRepository(ScheduledTransactionSplit).save(interestSplit);
      }

      // The extra principal child was never written here, so a clamped total had
      // nowhere to land: the parent would shrink while the children still summed
      // to the unclamped figure, and the posting path's split validator requires
      // exact 4dp equality between them (audit P5-008 again, on the child the
      // first fix did not reach). Written whenever it differs from what the
      // template holds -- in either direction, so one clamped installment does
      // not become the standing instruction (review #1131).
      if (extraPrincipalSplit && finalExtraPrincipal !== templateExtraAmount) {
        extraPrincipalSplit.amount = -finalExtraPrincipal;
        await m
          .getRepository(ScheduledTransactionSplit)
          .save(extraPrincipalSplit);
      }

      // Parent and children are written in the same transaction, so a posting
      // can never see one without the other. The parent is written whenever the
      // next installment differs from what the template holds: shrunk when the
      // debt no longer needs the whole configured payment, and grown back
      // toward the configured payment when a clamp written for one installment
      // no longer binds -- a voided final payment or an imported balance must
      // not leave the schedule billing the clamped figure forever (review
      // #1131). `allocateLoanPayment` bounds the total by the configured
      // payment, so this can never grow past what the user set.
      if (
        requiredParentAmount > 0 &&
        requiredParentAmount !== roundMoney(templateAmount)
      ) {
        await m
          .getRepository(ScheduledTransaction)
          .update(scheduledTransactionId, { amount: -requiredParentAmount });
        this.logger.log(
          `Loan payment recalculated: scheduled amount changed from ${templateAmount} to ${requiredParentAmount} (configured payment ${paymentAmount}, outstanding balance ${currentBalance})`,
        );
      }
    });
  }

  async findLoanAccountFromSplits(
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    return withScopedDb(this.dataSource, async (m) => {
      for (const split of splits) {
        if (split.transferAccountId) {
          const account = await m.getRepository(Account).findOne({
            where: { id: split.transferAccountId },
          });
          if (account && LOAN_LIKE_ACCOUNT_TYPES.has(account.accountType)) {
            return account.id;
          }
        }
      }
      return null;
    });
  }
}
