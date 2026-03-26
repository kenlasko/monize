import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";
import {
  calculatePaymentSplit,
  PaymentFrequency,
} from "../accounts/loan-amortization.util";
import {
  calculateMortgagePaymentSplit,
  MortgagePaymentFrequency,
} from "../accounts/mortgage-amortization.util";

@Injectable()
export class ScheduledTransactionLoanService {
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
      (s) =>
        s.transferAccountId === loanAccountId &&
        s !== extraPrincipalSplit,
    );
    const interestSplit = splits.find(
      (s) => s.categoryId && !s.transferAccountId,
    );

    // The base payment for amortization calculation excludes extra principal
    const extraPrincipalAmount = extraPrincipalSplit
      ? Math.abs(Number(extraPrincipalSplit.amount))
      : 0;
    const basePaymentAmount = paymentAmount - extraPrincipalAmount;

    let newSplit: { principal: number; interest: number };

    if (loanAccount.accountType === "MORTGAGE") {
      newSplit = calculateMortgagePaymentSplit(
        currentBalance,
        interestRate,
        basePaymentAmount,
        frequency as MortgagePaymentFrequency,
        loanAccount.isCanadianMortgage,
        loanAccount.isVariableRate,
      );
    } else {
      newSplit = calculatePaymentSplit(
        currentBalance,
        interestRate,
        basePaymentAmount,
        frequency,
      );
    }

    if (principalSplit) {
      principalSplit.amount = -newSplit.principal;
      await this.splitsRepository.save(principalSplit);
    }

    if (interestSplit) {
      interestSplit.amount = -newSplit.interest;
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
