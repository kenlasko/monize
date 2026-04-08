import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";
import { PaymentFrequency } from "../accounts/loan-amortization.util";
import {
  getPeriodicRate,
  getMortgagePeriodsPerYear,
  MortgagePaymentFrequency,
} from "../accounts/mortgage-amortization.util";
import { getPeriodsPerYear } from "../accounts/loan-amortization.util";

@Injectable()
export class ScheduledTransactionLoanService {
  private readonly logger = new Logger(ScheduledTransactionLoanService.name);

  constructor(
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(ScheduledTransactionSplit)
    private splitsRepository: Repository<ScheduledTransactionSplit>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
  ) {}

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
    loanAccountId: string,
  ): Promise<void> {
    const loanAccount = await this.accountsRepository.findOne({
      where: { id: loanAccountId },
    });

    if (!loanAccount) {
      return;
    }

    const scheduledTransaction =
      await this.scheduledTransactionsRepository.findOne({
        where: { id: scheduledTransactionId },
        relations: ["splits"],
      });

    if (!scheduledTransaction || !scheduledTransaction.isActive) {
      return;
    }

    const currentBalance = Math.abs(Number(loanAccount.currentBalance));

    if (currentBalance <= 0.01) {
      await this.scheduledTransactionsRepository.update(
        scheduledTransactionId,
        { isActive: false },
      );
      return;
    }

    const paymentAmount = Math.abs(Number(scheduledTransaction.amount));
    const interestRate = Number(loanAccount.interestRate) || 0;
    const frequency = (loanAccount.paymentFrequency ||
      scheduledTransaction.frequency) as PaymentFrequency;

    const splits = scheduledTransaction.splits || [];

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
      (s) => s.transferAccountId === loanAccountId && s !== extraPrincipalSplit,
    );
    const interestSplit = splits.find(
      (s) => s.categoryId && !s.transferAccountId,
    );

    // The base payment for amortization calculation excludes extra principal
    const extraPrincipalAmount = extraPrincipalSplit
      ? Math.abs(Number(extraPrincipalSplit.amount))
      : 0;
    const basePaymentAmount = paymentAmount - extraPrincipalAmount;

    // Get the previous split values (the values that were just posted).
    // These are still on the scheduled transaction template because posting
    // is read-only with respect to the template.
    const prevPrincipal = principalSplit
      ? Math.abs(Number(principalSplit.amount))
      : 0;
    const prevInterest = interestSplit
      ? Math.abs(Number(interestSplit.amount))
      : 0;

    let newInterest: number;
    let newPrincipal: number;

    if (prevInterest > 0 && prevPrincipal > 0 && interestRate > 0) {
      // Use the amortization recurrence relation to derive the next P/I split
      // from the previous values. This avoids depending on currentBalance,
      // which may be wrong if the opening balance had the wrong sign.
      //
      // In amortization:
      //   next_interest = prev_interest - (prev_principal + extra) * periodicRate
      //   next_principal = basePayment - next_interest
      //
      // The total principal (regular + extra) reduces the balance, which
      // causes the interest to drop by that amount times the periodic rate.
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

      const totalPrevPrincipal = prevPrincipal + extraPrincipalAmount;
      newInterest = prevInterest - totalPrevPrincipal * periodicRate;
      newInterest = Math.max(0, Math.round(newInterest * 100) / 100);
      newPrincipal = Math.round((basePaymentAmount - newInterest) * 100) / 100;

      if (newPrincipal < 0) {
        newPrincipal = 0;
      }
    } else {
      // No previous split data or no rate -- fall back to balance-based calc
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

      newInterest = Math.round(currentBalance * periodicRate * 100) / 100;
      newPrincipal = Math.round((basePaymentAmount - newInterest) * 100) / 100;
      if (newPrincipal < 0) newPrincipal = 0;
      if (newPrincipal > currentBalance) newPrincipal = currentBalance;
    }

    this.logger.log(
      `Recalculate loan splits: prevPrincipal=${prevPrincipal}, prevInterest=${prevInterest}, ` +
        `rate=${interestRate}%, freq=${frequency}, basePayment=${basePaymentAmount}, ` +
        `extra=${extraPrincipalAmount}, newPrincipal=${newPrincipal}, newInterest=${newInterest}, ` +
        `isMortgage=${loanAccount.accountType === "MORTGAGE"}, ` +
        `isCanadian=${loanAccount.isCanadianMortgage}`,
    );

    if (principalSplit) {
      principalSplit.amount = -newPrincipal;
      await this.splitsRepository.save(principalSplit);
    }

    if (interestSplit) {
      interestSplit.amount = -newInterest;
      await this.splitsRepository.save(interestSplit);
    }
  }

  async findLoanAccountFromSplits(
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    for (const split of splits) {
      if (split.transferAccountId) {
        const account = await this.accountsRepository.findOne({
          where: { id: split.transferAccountId },
        });
        if (
          account &&
          (account.accountType === "LOAN" || account.accountType === "MORTGAGE")
        ) {
          return account.id;
        }
      }
    }
    return null;
  }
}
