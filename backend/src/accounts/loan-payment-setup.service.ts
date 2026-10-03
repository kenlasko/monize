import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import {
  PreviewLoanPaymentSetupDto,
  PreviewLoanPaymentSetupResponseDto,
  SetupLoanPaymentsDto,
  SetupLoanPaymentsResponseDto,
} from "./dto/setup-loan-payments.dto";
import { roundMoney } from "../common/round.util";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import {
  calculatePaymentSplit,
  PaymentFrequency,
  SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY,
} from "./loan-amortization.util";
import {
  calculateMortgagePaymentSplit,
  getPeriodicRate,
  toMortgagePaymentFrequency,
} from "./mortgage-amortization.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  mortgageTermEndDate,
  periodsPerYearForStoredFrequency,
} from "./payment-frequency.util";
import { localDateForColumn } from "../common/date-utils";
import { allocateLoanPayment } from "./loan-payment-waterfall.util";
import { FrequencyType as FrequencyTypeDto } from "../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import {
  MortgageType,
  PrepaymentMode,
  compoundingFor,
  mortgageTypeOf,
  prepaymentModeColumn,
  storesConstantPayment,
} from "./mortgage-type.util";
import {
  MortgageMethodTerms,
  assertMortgageMethodTerms,
  nonAnnuityInstallment,
} from "./mortgage-installment.util";
import { datedLoanDebt } from "./dated-loan-debt.util";

@Injectable()
export class LoanPaymentSetupService {
  private readonly logger = new Logger(LoanPaymentSetupService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  /**
   * The first installment a setup of `dto` would schedule, for a LINEAR or
   * INTEREST_ONLY mortgage: what `setupLoanPayments` requires its
   * `paymentAmount` to equal, priced here by the same code
   * (`priceFirstMethodInstallment`) so the dialog shows the figure the write
   * will accept (spec section 5.5). Writes nothing. An annuity mortgage or a
   * plain loan has a constant payment the user states, so it answers
   * `derivesInstallment: false` with no figures.
   */
  async previewFirstInstallment(
    userId: string,
    accountId: string,
    dto: PreviewLoanPaymentSetupDto,
  ): Promise<PreviewLoanPaymentSetupResponseDto> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );
    if (!account) {
      throw new NotFoundException(
        tr("errors.accounts.notFound", "Account not found"),
      );
    }
    const mortgageType =
      account.accountType === AccountType.MORTGAGE
        ? (dto.mortgageType ?? mortgageTypeOf(account))
        : null;
    if (mortgageType === null || storesConstantPayment(mortgageType)) {
      return {
        derivesInstallment: false,
        principalPayment: null,
        interestPayment: null,
        paymentAmount: null,
      };
    }
    const priced = await this.priceFirstMethodInstallment(
      account,
      mortgageType,
      prepaymentModeColumn(
        mortgageType,
        dto.prepaymentMode,
        account.prepaymentMode,
      ),
      dto,
      dto.interestRate || Number(account.interestRate) || 0,
    );
    return {
      derivesInstallment: true,
      principalPayment: priced.principal,
      interestPayment: priced.interest,
      paymentAmount: roundMoney(
        priced.principal + priced.interest + (dto.extraPrincipal || 0),
      ),
    };
  }

  /**
   * A LINEAR or INTEREST_ONLY mortgage has no constant payment: its first
   * installment is table 4.3's at the first due date, priced from the ledger
   * debt through that date (spec section 5.5). Setup makes that date payment
   * 1, so the calendar starts there. Shared by the setup and its preview, so
   * the figure the dialog shows is the one the write checks against.
   */
  private async priceFirstMethodInstallment(
    account: Account,
    mortgageType: MortgageType,
    prepaymentMode: PrepaymentMode | null,
    dto: {
      nextDueDate: string;
      paymentFrequency: string;
      amortizationMonths?: number;
    },
    interestRate: number,
  ): Promise<{ principal: number; interest: number; debt: number }> {
    const terms: MortgageMethodTerms = {
      prepaymentMode,
      originalPrincipal: account.originalPrincipal,
      openingBalance: account.openingBalance,
      amortizationMonths: dto.amortizationMonths ?? account.amortizationMonths,
      paymentStartDate: dto.nextDueDate,
      paymentFrequency: dto.paymentFrequency,
    };
    assertMortgageMethodTerms(mortgageType, terms);
    const debt = await withScopedDb(this.dataSource, (m) =>
      datedLoanDebt(m, account, dto.nextDueDate),
    );
    if (debt === null) {
      throw new ServiceUnavailableException(
        tr(
          "errors.accounts.loanLedgerUnreadable",
          "This loan's balance could not be read. Try again.",
        ),
      );
    }
    // `assertMortgageMethodTerms` refused every input that leaves this null.
    const installment = nonAnnuityInstallment(
      mortgageType,
      terms,
      dto.nextDueDate,
      debt,
      getPeriodicRate(
        interestRate,
        periodsPerYearForStoredFrequency(dto.paymentFrequency) ??
          DEFAULT_PERIODS_PER_YEAR,
        mortgageType,
      ),
    )!;
    return { ...installment, debt };
  }

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
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );

    if (!account) {
      throw new NotFoundException(
        tr("errors.accounts.notFound", "Account not found"),
      );
    }

    if (
      account.accountType !== AccountType.LOAN &&
      account.accountType !== AccountType.MORTGAGE &&
      account.accountType !== AccountType.LINE_OF_CREDIT
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.onlyLoanMortgageLoc",
          "Only loan, mortgage, and line of credit accounts support scheduled payment setup",
        ),
      );
    }

    if (account.scheduledTransactionId) {
      throw new BadRequestException(
        tr(
          "errors.accounts.alreadyHasScheduledPayment",
          "This account already has a scheduled payment configured. Edit the existing scheduled transaction instead.",
        ),
      );
    }

    // Verify source account exists and belongs to user
    const sourceAccount = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: dto.sourceAccountId, userId },
      }),
    );
    if (!sourceAccount) {
      throw new BadRequestException(
        tr("errors.accounts.sourceNotFound", "Source account not found"),
      );
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

    // The type this request leaves the mortgage with: its own type, else the
    // stored type. Null for any other account type.
    const mortgageType =
      account.accountType === AccountType.MORTGAGE
        ? (dto.mortgageType ?? mortgageTypeOf(account))
        : null;

    // Calculate principal/interest split for the next payment
    const currentBalance = Math.abs(Number(account.currentBalance));
    const interestRate = dto.interestRate || Number(account.interestRate) || 0;
    const extraPrincipal = dto.extraPrincipal || 0;
    // Base payment amount excludes extra principal for split calculation
    const basePaymentAmount = dto.paymentAmount - extraPrincipal;

    let principalPayment: number;
    let interestPayment: number;

    // A LINEAR or INTEREST_ONLY mortgage has no constant payment: its first
    // installment is table 4.3's at the first due date, priced here from the
    // ledger debt through that date (spec section 5.5). The request's payment
    // is checked against it rather than trusted, and is not stored.
    const derivesInstallment =
      mortgageType !== null && !storesConstantPayment(mortgageType);
    const prepaymentMode =
      mortgageType !== null
        ? prepaymentModeColumn(
            mortgageType,
            dto.prepaymentMode,
            account.prepaymentMode,
          )
        : null;
    let installmentDebt: number | null = null;

    if (derivesInstallment) {
      const priced = await this.priceFirstMethodInstallment(
        account,
        mortgageType,
        prepaymentMode,
        dto,
        interestRate,
      );
      installmentDebt = priced.debt;
      const expectedPayment = roundMoney(
        priced.principal + priced.interest + extraPrincipal,
      );
      if (Math.abs(dto.paymentAmount - expectedPayment) > 0.00005) {
        throw new BadRequestException(
          tr(
            "errors.accounts.mortgageMethodPaymentMismatch",
            `The payment amount must be this ${mortgageType} mortgage's first installment plus any extra principal, which the server derives from the debt, the rate and the amortization; preview it again`,
            { type: mortgageType },
          ),
        );
      }
      principalPayment = priced.principal;
      interestPayment = priced.interest;
    } else if (
      dto.detectedInterestAmount != null &&
      dto.detectedInterestAmount >= 0
    ) {
      // Use the interest amount detected from imported transaction history.
      // This continues the actual P/I ratio from the existing data rather than
      // recalculating from the amortization formula, which may differ due to
      // compounding method, rate changes, or rounding differences.
      interestPayment = dto.detectedInterestAmount;
      principalPayment = basePaymentAmount - interestPayment;
      if (principalPayment < 0) {
        principalPayment = 0;
      }
    } else if (mortgageType !== null) {
      // Every mortgage is split by its type (spec section 5.5), the type this
      // same request writes: a request's own type decides the split it
      // is submitted with, never the stored ones they replace.
      //
      // The DTO's frequency is a *recurrence* spelling, read through the one
      // lookup that knows both domains. A semi-annually compounded mortgage
      // refuses a cadence the mortgage helpers cannot express (quarterly,
      // yearly), as the setup dialog does not offer them, rather than compute
      // a conversion nothing else in the app uses for it.
      if (
        compoundingFor(mortgageType) === "SEMI_ANNUAL" &&
        !toMortgagePaymentFrequency(dto.paymentFrequency)
      ) {
        throw new BadRequestException(
          tr(
            "errors.accounts.mortgageFrequencyUnsupported",
            "Canadian mortgages cannot be scheduled at this payment frequency",
            { frequency: dto.paymentFrequency },
          ),
        );
      }
      if (interestRate > 0) {
        const split = calculateMortgagePaymentSplit(
          currentBalance,
          interestRate,
          basePaymentAmount,
          periodsPerYearForStoredFrequency(dto.paymentFrequency) ??
            DEFAULT_PERIODS_PER_YEAR,
          mortgageType,
        );
        principalPayment = split.principal;
        interestPayment = split.interest;
      } else {
        // No interest: the whole base payment is principal, as for any loan
        // below. A zero recorded balance means the history is not imported
        // yet, so it does not cap the principal; the waterfall bounds it by a
        // known balance.
        principalPayment = basePaymentAmount;
        interestPayment = 0;
      }
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
      // No interest rate: the whole of the base payment goes to principal.
      //
      // This branch alone used `dto.paymentAmount` rather than
      // `basePaymentAmount`, so extra principal was counted twice -- once inside
      // the regular principal child and again in its own child. The children
      // then summed to payment + extra against a parent of payment, and
      // `ScheduledTransactionsService.create` validates that sum to exact 4dp
      // equality: setting up payments on a 0% loan with any extra principal
      // failed outright.
      principalPayment = basePaymentAmount;
      interestPayment = 0;
    }

    // The clamp sequence -- interest-first, balance caps, extra absorbing the
    // shortfall -- is `allocateLoanPayment`, shared with the per-posting
    // recalculation in `ScheduledTransactionLoanService` because the two must
    // agree about what any installment looks like. A zero recorded balance
    // here means the history has not been imported yet, not that the loan is
    // paid off, so it does not bound the payment.
    const allocation = allocateLoanPayment({
      paymentAmount: dto.paymentAmount,
      extraPrincipal,
      interest: interestPayment,
      principal: principalPayment,
      currentBalance:
        installmentDebt !== null
          ? installmentDebt
          : currentBalance > 0
            ? currentBalance
            : null,
    });
    principalPayment = allocation.principal;
    interestPayment = allocation.interest;
    const scheduledExtraPrincipal = allocation.extraPrincipal;
    const parentAmount = allocation.total;

    // The DTO accepts loan spellings; mortgage callers may also carry the
    // mortgage ones, so both tables are merged rather than a third copy written.
    // Deriving it means a new frequency in either domain is scheduled correctly
    // here without anybody remembering this line.
    //
    // Refused rather than defaulted. `?? "MONTHLY"` scheduled an unmapped
    // frequency twelve times a year and said nothing -- the same silent
    // fall-through migration 165 exists to heal -- and the `as any` that used to
    // sit on the payload below hid it from the compiler too. A frequency the
    // table cannot express is a 400, and `loan-payment-frequency.guard.spec.ts`
    // reads the DTO's own `@IsIn` list so the refusal is unreachable for every
    // value the DTO actually accepts.
    const scheduledFrequency =
      SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY[dto.paymentFrequency];
    if (!scheduledFrequency) {
      throw new BadRequestException(
        tr(
          "errors.accounts.paymentFrequencyUnsupported",
          "This payment frequency cannot be scheduled",
          { frequency: dto.paymentFrequency },
        ),
      );
    }

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
    if (scheduledExtraPrincipal > 0) {
      splits.push({
        transferAccountId: accountId,
        amount: -scheduledExtraPrincipal,
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
        amount: -parentAmount,
        currencyCode: account.currencyCode,
        frequency: FrequencyTypeDto[scheduledFrequency],
        nextDueDate: dto.nextDueDate,
        startDate: dto.nextDueDate,
        isActive: true,
        autoPost: dto.autoPost ?? false,
        splits,
      },
    );

    // Update the account with loan payment details
    const updateData: Partial<Account> = {
      // Null for a LINEAR or INTEREST_ONLY mortgage, which has no constant
      // payment to store (spec decision 11, the column's CHECK).
      paymentAmount: derivesInstallment ? null : dto.paymentAmount,
      // The configured standing instruction, not the possibly-clamped first
      // installment: this is what the recalculation grows the extra back to
      // once a transient clamp (an interest spike) has passed.
      extraPaymentAmount: extraPrincipal,
      paymentFrequency: dto.paymentFrequency,
      // Through `localDateForColumn`, not `new Date(...)`: this is a TypeORM
      // `date` column, serialized with local getters, so a UTC-midnight value
      // is stored a day early west of Greenwich -- and this date anchors every
      // amortization the account later computes.
      paymentStartDate: localDateForColumn(dto.nextDueDate),
      sourceAccountId: dto.sourceAccountId,
      interestCategoryId,
      scheduledTransactionId: scheduledTransaction.id,
    };

    if (interestRate > 0) {
      updateData.interestRate = interestRate;
    }

    if (account.accountType === AccountType.MORTGAGE) {
      // The type only when the request names one; otherwise the stored
      // column stands.
      if (dto.mortgageType !== undefined) {
        updateData.mortgageType = dto.mortgageType;
      }
      // Null unless the type this request leaves is LINEAR (spec decision 10).
      updateData.prepaymentMode = prepaymentMode;
      if (dto.amortizationMonths) {
        updateData.amortizationMonths = dto.amortizationMonths;
      }
      if (dto.termMonths) {
        updateData.termMonths = dto.termMonths;
        updateData.termEndDate = mortgageTermEndDate(
          new Date(dto.nextDueDate),
          dto.termMonths,
        );
      }
      if (!account.originalPrincipal) {
        updateData.originalPrincipal = Math.abs(Number(account.openingBalance));
      }
    }

    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).update(accountId, updateData),
    );

    this.logger.log(
      `Set up ${accountLabel.toLowerCase()} payments for account ${account.name}: ` +
        `$${dto.paymentAmount} ${dto.paymentFrequency}, next due ${dto.nextDueDate}` +
        (parentAmount !== roundMoney(dto.paymentAmount)
          ? `, first installment clamped to $${parentAmount} against the outstanding balance`
          : ""),
    );

    return {
      scheduledTransactionId: scheduledTransaction.id,
      accountId,
      paymentAmount: dto.paymentAmount,
      firstInstallmentAmount: parentAmount,
      paymentFrequency: dto.paymentFrequency,
      nextDueDate: dto.nextDueDate,
    };
  }
}
