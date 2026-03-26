import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import {
  SetupLoanPaymentsDto,
  SetupLoanPaymentsResponseDto,
} from "./dto/setup-loan-payments.dto";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import {
  calculatePaymentSplit,
  PaymentFrequency,
} from "./loan-amortization.util";
import {
  calculateMortgagePaymentSplit,
  MortgagePaymentFrequency,
} from "./mortgage-amortization.util";

@Injectable()
export class LoanPaymentSetupService {
  private readonly logger = new Logger(LoanPaymentSetupService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  /**
   * Set up scheduled loan/mortgage payments for an existing account.
   * Creates a scheduled transaction with principal/interest splits
   * and updates the account's loan-specific fields.
   */
  async setupLoanPayments(
    userId: string,
    accountId: string,
    dto: SetupLoanPaymentsDto,
  ): Promise<SetupLoanPaymentsResponseDto> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId, userId },
    });

    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (
      account.accountType !== AccountType.LOAN &&
      account.accountType !== AccountType.MORTGAGE &&
      account.accountType !== AccountType.LINE_OF_CREDIT
    ) {
      throw new BadRequestException(
        "Only loan, mortgage, and line of credit accounts support scheduled payment setup",
      );
    }

    if (account.scheduledTransactionId) {
      throw new BadRequestException(
        "This account already has a scheduled payment configured. Edit the existing scheduled transaction instead.",
      );
    }

    // Verify source account exists and belongs to user
    const sourceAccount = await this.accountsRepository.findOne({
      where: { id: dto.sourceAccountId, userId },
    });
    if (!sourceAccount) {
      throw new BadRequestException("Source account not found");
    }

    // Resolve interest category
    let interestCategoryId = dto.interestCategoryId || null;
    if (!interestCategoryId) {
      const { interestCategory } =
        await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCategoryId = interestCategory.id;
      }
    }

    // Calculate principal/interest split for the next payment
    const currentBalance = Math.abs(Number(account.currentBalance));
    const interestRate = dto.interestRate || Number(account.interestRate) || 0;
    const extraPrincipal = dto.extraPrincipal || 0;
    // Base payment amount excludes extra principal for split calculation
    const basePaymentAmount = dto.paymentAmount - extraPrincipal;

    let principalPayment: number;
    let interestPayment: number;

    if (dto.detectedInterestAmount != null && dto.detectedInterestAmount >= 0) {
      // Use the interest amount detected from imported transaction history.
      // This continues the actual P/I ratio from the existing data rather than
      // recalculating from the amortization formula, which may differ due to
      // compounding method, rate changes, or rounding differences.
      interestPayment = dto.detectedInterestAmount;
      principalPayment = basePaymentAmount - interestPayment;
      if (principalPayment < 0) {
        principalPayment = 0;
      }
    } else if (
      account.accountType === AccountType.MORTGAGE &&
      (dto.isCanadianMortgage || account.isCanadianMortgage)
    ) {
      // Use mortgage-specific calculation for Canadian mortgages
      const split = calculateMortgagePaymentSplit(
        currentBalance,
        interestRate,
        basePaymentAmount,
        dto.paymentFrequency as MortgagePaymentFrequency,
        dto.isCanadianMortgage ?? account.isCanadianMortgage ?? false,
        dto.isVariableRate ?? account.isVariableRate ?? false,
      );
      principalPayment = split.principal;
      interestPayment = split.interest;
    } else if (interestRate > 0) {
      const split = calculatePaymentSplit(
        currentBalance,
        interestRate,
        basePaymentAmount,
        dto.paymentFrequency as PaymentFrequency,
      );
      principalPayment = split.principal;
      interestPayment = split.interest;
    } else {
      // No interest rate - entire payment goes to principal
      principalPayment = dto.paymentAmount;
      interestPayment = 0;
    }

    // Map frequency for scheduled transactions
    // Mortgage frequencies like ACCELERATED_BIWEEKLY map to BIWEEKLY in scheduling
    const frequencyMap: Record<string, string> = {
      WEEKLY: "WEEKLY",
      BIWEEKLY: "BIWEEKLY",
      SEMIMONTHLY: "SEMIMONTHLY",
      MONTHLY: "MONTHLY",
      QUARTERLY: "QUARTERLY",
      YEARLY: "YEARLY",
      ACCELERATED_BIWEEKLY: "BIWEEKLY",
      ACCELERATED_WEEKLY: "WEEKLY",
      SEMI_MONTHLY: "SEMIMONTHLY",
    };
    const scheduledFrequency = frequencyMap[dto.paymentFrequency] || "MONTHLY";

    // Build scheduled transaction splits
    const splits: Array<{
      transferAccountId?: string;
      categoryId?: string;
      amount: number;
      memo: string;
    }> = [
      {
        transferAccountId: accountId,
        amount: -principalPayment,
        memo: "Principal",
      },
    ];

    if (interestPayment > 0) {
      splits.push({
        categoryId: interestCategoryId || undefined,
        amount: -interestPayment,
        memo: "Interest",
      });
    }

    // Extra principal as a separate transfer split to the loan account,
    // matching the structure of imported transactions
    if (extraPrincipal > 0) {
      splits.push({
        transferAccountId: accountId,
        amount: -extraPrincipal,
        memo: "Extra Principal",
      });
    }

    const accountLabel =
      account.accountType === AccountType.MORTGAGE ? "Mortgage" : "Loan";

    // Create the scheduled transaction
    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: dto.sourceAccountId,
        name: `${accountLabel} Payment - ${account.name}`,
        payeeId: dto.payeeId || undefined,
        payeeName: dto.payeeName || account.institution || undefined,
        amount: -dto.paymentAmount,
        currencyCode: account.currencyCode,
        frequency: scheduledFrequency as any,
        nextDueDate: dto.nextDueDate,
        startDate: dto.nextDueDate,
        isActive: true,
        autoPost: dto.autoPost ?? false,
        splits,
      },
    );

    // Update the account with loan payment details
    const updateData: Partial<Account> = {
      paymentAmount: dto.paymentAmount,
      paymentFrequency: dto.paymentFrequency,
      paymentStartDate: new Date(dto.nextDueDate),
      sourceAccountId: dto.sourceAccountId,
      interestCategoryId,
      scheduledTransactionId: scheduledTransaction.id,
    };

    if (interestRate > 0) {
      updateData.interestRate = interestRate;
    }

    if (account.accountType === AccountType.MORTGAGE) {
      if (dto.isCanadianMortgage !== undefined) {
        updateData.isCanadianMortgage = dto.isCanadianMortgage;
      }
      if (dto.isVariableRate !== undefined) {
        updateData.isVariableRate = dto.isVariableRate;
      }
      if (dto.amortizationMonths) {
        updateData.amortizationMonths = dto.amortizationMonths;
      }
      if (dto.termMonths) {
        updateData.termMonths = dto.termMonths;
        const termEndDate = new Date(dto.nextDueDate);
        termEndDate.setMonth(termEndDate.getMonth() + dto.termMonths);
        updateData.termEndDate = termEndDate;
      }
      if (!account.originalPrincipal) {
        updateData.originalPrincipal = Math.abs(Number(account.openingBalance));
      }
    }

    await this.accountsRepository.update(accountId, updateData);

    this.logger.log(
      `Set up ${accountLabel.toLowerCase()} payments for account ${account.name}: ` +
        `$${dto.paymentAmount} ${dto.paymentFrequency}, next due ${dto.nextDueDate}`,
    );

    return {
      scheduledTransactionId: scheduledTransaction.id,
      accountId,
      paymentAmount: dto.paymentAmount,
      paymentFrequency: dto.paymentFrequency,
      nextDueDate: dto.nextDueDate,
    };
  }
}
