import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { CreateAccountDto } from "./dto/create-account.dto";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import {
  calculateAmortization,
  PaymentFrequency,
  AmortizationResult,
} from "./loan-amortization.util";
import {
  calculateMortgageAmortization,
  recalculateMortgageAfterRateChange,
  getMortgagePeriodsPerYear,
  MortgagePaymentFrequency,
  MortgageAmortizationInput,
  MortgageAmortizationResult,
} from "./mortgage-amortization.util";
import { formatDateYMD } from "../common/date-utils";

@Injectable()
export class LoanMortgageAccountService {
  private readonly logger = new Logger(LoanMortgageAccountService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  async createLoanAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
    const {
      openingBalance = 0,
      paymentAmount,
      paymentFrequency,
      paymentStartDate,
      sourceAccountId,
      interestCategoryId,
      interestRate,
      institution,
      ...accountData
    } = createAccountDto;

    if (
      !paymentAmount ||
      !paymentFrequency ||
      !paymentStartDate ||
      !sourceAccountId
    ) {
      throw new BadRequestException(
        "Loan accounts require paymentAmount, paymentFrequency, paymentStartDate, and sourceAccountId",
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException("Loan accounts require an interest rate");
    }
    if (!institution) {
      throw new BadRequestException(
        "Loan accounts require an institution name",
      );
    }

    let interestCatId = interestCategoryId;

    if (!interestCatId) {
      const { interestCategory } =
        await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCatId = interestCategory.id;
      }
    }

    const loanAmount = Math.abs(openingBalance);
    const amortization = calculateAmortization(
      loanAmount,
      interestRate,
      paymentAmount,
      paymentFrequency as PaymentFrequency,
      new Date(paymentStartDate),
    );

    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance: -loanAmount,
      currentBalance: -loanAmount,
      interestRate,
      institution,
      paymentAmount,
      paymentFrequency,
      paymentStartDate: new Date(paymentStartDate),
      sourceAccountId,
      interestCategoryId: interestCatId || null,
    });

    const savedAccount = await this.accountsRepository.save(account);

    const endDateStr =
      amortization.totalPayments > 0 && amortization.totalPayments < 10000
        ? formatDateYMD(amortization.endDate)
        : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: sourceAccountId,
        name: `Loan Payment - ${savedAccount.name}`,
        payeeName: institution,
        amount: -paymentAmount,
        currencyCode: accountData.currencyCode,
        frequency: paymentFrequency as any,
        nextDueDate: paymentStartDate,
        startDate: paymentStartDate,
        endDate: endDateStr,
        isActive: true,
        autoPost: false,
        splits: [
          {
            transferAccountId: savedAccount.id,
            amount: -amortization.principalPayment,
            memo: "Principal",
          },
          {
            categoryId: interestCatId || undefined,
            amount: -amortization.interestPayment,
            memo: "Interest",
          },
        ],
      },
    );

    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await this.accountsRepository.save(savedAccount);

    return savedAccount;
  }

  async createMortgageAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
    const {
      openingBalance = 0,
      mortgagePaymentFrequency,
      paymentStartDate,
      sourceAccountId,
      interestCategoryId,
      interestRate,
      institution,
      isCanadianMortgage = false,
      isVariableRate = false,
      termMonths,
      amortizationMonths,
      ...accountData
    } = createAccountDto;

    if (
      !mortgagePaymentFrequency ||
      !paymentStartDate ||
      !sourceAccountId ||
      !amortizationMonths
    ) {
      throw new BadRequestException(
        "Mortgage accounts require mortgagePaymentFrequency, paymentStartDate, sourceAccountId, and amortizationMonths",
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException(
        "Mortgage accounts require an interest rate",
      );
    }
    if (!institution) {
      throw new BadRequestException(
        "Mortgage accounts require an institution name",
      );
    }

    let interestCatId = interestCategoryId;

    if (!interestCatId) {
      const { interestCategory } =
        await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCatId = interestCategory.id;
      }
    }

    const mortgageAmount = Math.abs(openingBalance);
    const amortizationInput: MortgageAmortizationInput = {
      principal: mortgageAmount,
      annualRate: interestRate,
      amortizationMonths,
      paymentFrequency: mortgagePaymentFrequency as MortgagePaymentFrequency,
      isCanadian: isCanadianMortgage,
      isVariableRate,
      startDate: new Date(paymentStartDate),
    };
    const amortization = calculateMortgageAmortization(amortizationInput);

    let termEndDate: Date | null = null;
    if (termMonths) {
      termEndDate = new Date(paymentStartDate);
      termEndDate.setMonth(termEndDate.getMonth() + termMonths);
    }

    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance: -mortgageAmount,
      currentBalance: -mortgageAmount,
      interestRate,
      institution,
      paymentAmount: amortization.paymentAmount,
      paymentFrequency: mortgagePaymentFrequency,
      paymentStartDate: new Date(paymentStartDate),
      sourceAccountId,
      interestCategoryId: interestCatId || null,
      isCanadianMortgage,
      isVariableRate,
      termMonths: termMonths || null,
      termEndDate,
      amortizationMonths,
      originalPrincipal: mortgageAmount,
    });

    const savedAccount = await this.accountsRepository.save(account);

    const frequencyMap: Record<string, string> = {
      MONTHLY: "MONTHLY",
      SEMI_MONTHLY: "SEMI_MONTHLY",
      BIWEEKLY: "BIWEEKLY",
      ACCELERATED_BIWEEKLY: "BIWEEKLY",
      WEEKLY: "WEEKLY",
      ACCELERATED_WEEKLY: "WEEKLY",
    };
    const scheduledFrequency =
      frequencyMap[mortgagePaymentFrequency] || "MONTHLY";

    const endDateStr =
      amortization.totalPayments > 0 && amortization.totalPayments < 10000
        ? formatDateYMD(amortization.endDate)
        : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: sourceAccountId,
        name: `Mortgage Payment - ${savedAccount.name}`,
        payeeName: institution,
        amount: -amortization.paymentAmount,
        currencyCode: accountData.currencyCode,
        frequency: scheduledFrequency as any,
        nextDueDate: paymentStartDate,
        startDate: paymentStartDate,
        endDate: endDateStr,
        isActive: true,
        autoPost: false,
        splits: [
          {
            transferAccountId: savedAccount.id,
            amount: -amortization.principalPayment,
            memo: "Principal",
          },
          {
            categoryId: interestCatId || undefined,
            amount: -amortization.interestPayment,
            memo: "Interest",
          },
        ],
      },
    );

    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await this.accountsRepository.save(savedAccount);

    return savedAccount;
  }

  previewMortgageAmortization(
    mortgageAmount: number,
    interestRate: number,
    amortizationMonths: number,
    paymentFrequency: MortgagePaymentFrequency,
    paymentStartDate: Date,
    isCanadian: boolean,
    isVariableRate: boolean,
  ): MortgageAmortizationResult {
    return calculateMortgageAmortization({
      principal: Math.abs(mortgageAmount),
      annualRate: interestRate,
      amortizationMonths,
      paymentFrequency,
      isCanadian,
      isVariableRate,
      startDate: paymentStartDate,
    });
  }

  previewLoanAmortization(
    loanAmount: number,
    interestRate: number,
    paymentAmount: number,
    paymentFrequency: PaymentFrequency,
    paymentStartDate: Date,
  ): AmortizationResult {
    return calculateAmortization(
      Math.abs(loanAmount),
      interestRate,
      paymentAmount,
      paymentFrequency,
      paymentStartDate,
    );
  }

  async updateMortgageRate(
    account: Account,
    userId: string,
    newRate: number,
    effectiveDate: Date,
    newPaymentAmount?: number,
  ): Promise<{
    newRate: number;
    paymentAmount: number;
    principalPayment: number;
    interestPayment: number;
    effectiveDate: string;
  }> {
    if (account.accountType !== AccountType.MORTGAGE) {
      throw new BadRequestException(
        "This operation is only valid for mortgage accounts",
      );
    }

    if (account.isClosed) {
      throw new BadRequestException("Cannot update rate on a closed account");
    }

    const currentBalance = Math.abs(Number(account.currentBalance));
    const startDate = account.paymentStartDate || new Date();
    // M21: Use calendar months instead of 30-day approximation
    const monthsElapsed = Math.max(
      0,
      (effectiveDate.getFullYear() - startDate.getFullYear()) * 12 +
        (effectiveDate.getMonth() - startDate.getMonth()),
    );
    const remainingAmortizationMonths = Math.max(
      12,
      (account.amortizationMonths || 300) - monthsElapsed,
    );

    let paymentAmount: number;
    let principalPayment: number;
    let interestPayment: number;

    if (newPaymentAmount) {
      paymentAmount = newPaymentAmount;

      const periodsPerYear = getMortgagePeriodsPerYear(
        (account.paymentFrequency || "MONTHLY") as MortgagePaymentFrequency,
      );
      const isCanadian = account.isCanadianMortgage || false;
      const isVariable = account.isVariableRate || false;

      let periodicRate: number;
      if (isCanadian && !isVariable) {
        const semiAnnualRate = newRate / 100 / 2;
        periodicRate = Math.pow(1 + semiAnnualRate, 2 / periodsPerYear) - 1;
      } else {
        periodicRate = newRate / 100 / periodsPerYear;
      }

      interestPayment = Math.round(currentBalance * periodicRate * 100) / 100;
      principalPayment =
        Math.round((paymentAmount - interestPayment) * 100) / 100;
    } else {
      const result = recalculateMortgageAfterRateChange(
        currentBalance,
        newRate,
        remainingAmortizationMonths,
        (account.paymentFrequency || "MONTHLY") as MortgagePaymentFrequency,
        account.isCanadianMortgage || false,
        account.isVariableRate || false,
      );

      paymentAmount = result.paymentAmount;
      principalPayment = result.principalPayment;
      interestPayment = result.interestPayment;
    }

    account.interestRate = newRate;
    account.paymentAmount = paymentAmount;
    await this.accountsRepository.save(account);

    if (account.scheduledTransactionId) {
      try {
        await this.scheduledTransactionsService.update(
          userId,
          account.scheduledTransactionId,
          {
            amount: -paymentAmount,
            splits: [
              {
                transferAccountId: account.id,
                amount: -principalPayment,
                memo: "Principal",
              },
              {
                categoryId: account.interestCategoryId || undefined,
                amount: -interestPayment,
                memo: "Interest",
              },
            ],
          },
        );
      } catch (error) {
        this.logger.warn(
          `Could not update scheduled transaction: ${error.message}`,
        );
      }
    }

    return {
      newRate,
      paymentAmount,
      principalPayment,
      interestPayment,
      effectiveDate: formatDateYMD(effectiveDate),
    };
  }
}
