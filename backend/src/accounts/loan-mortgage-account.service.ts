import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CreateAccountDto } from "./dto/create-account.dto";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { FrequencyType as FrequencyTypeDto } from "../scheduled-transactions/dto/create-scheduled-transaction.dto";
import {
  calculateAmortization,
  LOAN_FREQUENCY_TO_RECURRENCE,
  MAX_DATEABLE_PAYMENTS,
  PaymentFrequency,
  AmortizationResult,
} from "./loan-amortization.util";
import {
  calculateMortgageAmortization,
  getMortgagePeriodsPerYear,
  getPeriodicRate,
  MORTGAGE_FREQUENCY_TO_RECURRENCE,
  MortgagePaymentFrequency,
  MortgageAmortizationInput,
  MortgageAmortizationResult,
} from "./mortgage-amortization.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  mortgageTermEndDate,
  periodsPerYearForStoredFrequency,
  toMortgagePaymentFrequency,
} from "./payment-frequency.util";
import {
  formatDateYMD,
  localDateForColumn,
  todayYMD,
} from "../common/date-utils";
import { ledgerMovementPredicate } from "../common/ledger-balance.sql";
import { roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";
import {
  LoanRateChangesService,
  derivedInstallmentType,
  refuseStatedPayment,
} from "../loan-rate-changes/loan-rate-changes.service";
import { withScopedDb } from "../common/db/scoped-db";
import { datedLoanDebt } from "./dated-loan-debt.util";
import {
  MortgageType,
  mortgageTypeColumns,
  mortgageTypeOf,
  prepaymentModeColumn,
  requestedMortgageType,
  storesConstantPayment,
} from "./mortgage-type.util";
import {
  assertMortgageMethodTerms,
  nonAnnuityInstallment,
} from "./mortgage-installment.util";
import { Transaction } from "../transactions/entities/transaction.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import {
  InstallmentHistory,
  LoanPaymentDetectorService,
} from "./loan-payment-detector.service";
import { effectiveAnnualRateOn } from "./effective-loan-rate.util";
import {
  detectMortgageType,
  MortgageTypeDetection,
} from "./mortgage-type-detection.util";
import {
  DatedMortgageTypeSampleDto,
  DetectMortgageTypeDto,
  MortgageTypeHistoryDetectionResponseDto,
} from "./dto/detect-mortgage-type.dto";
import {
  PaymentMatchingDto,
  PaymentMatchingFailureDto,
} from "./dto/payment-matching.dto";
import { LoanPaymentMatchingService } from "./loan-payment-matching.service";

/**
 * A loan or mortgage just created, with the outcome of the "Payment matching"
 * rule its request asked for: `paymentMatchingRuleId` set, or
 * `paymentMatchingError` saying why there is none (the account stays).
 */
export type CreatedLoanAccount = Account & {
  paymentMatchingError?: PaymentMatchingFailureDto | null;
};

/**
 * The installments a history detection reads: the latest three consecutive
 * ones posted at one rate (docs/specs/mortgage-types.md, section 10).
 */
const HISTORY_DETECTION_SAMPLES = 3;

@Injectable()
export class LoanMortgageAccountService {
  private readonly logger = new Logger(LoanMortgageAccountService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => LoanRateChangesService))
    private loanRateChangesService: LoanRateChangesService,
    private loanPaymentDetectorService: LoanPaymentDetectorService,
    private loanPaymentMatchingService: LoanPaymentMatchingService,
  ) {}

  /**
   * The "Payment matching" rule of a loan this service just saved with its
   * schedule. The account and the schedule are already committed (spec
   * section 15 item 6), so a refusal is reported on the returned account,
   * never thrown.
   */
  private async withPaymentMatching(
    userId: string,
    savedAccount: Account,
    paymentMatching: PaymentMatchingDto | undefined,
  ): Promise<CreatedLoanAccount> {
    if (!paymentMatching) return savedAccount;
    const outcome =
      await this.loanPaymentMatchingService.createMatchingRuleReported(
        userId,
        savedAccount.id,
        paymentMatching,
      );
    savedAccount.paymentMatchingRuleId = outcome.ruleId;
    return Object.assign(savedAccount, { paymentMatchingError: outcome.error });
  }

  /**
   * Resolve a display name for the lender/institution backing a loan or
   * mortgage. The account form sends the selected institution as `institutionId`
   * (the modern Institutions table) and no longer fills the legacy free-text
   * `institution` field, so requiring the latter rejected accounts that did have
   * an institution set. Prefer the explicit free-text value when present (legacy
   * callers, imports), otherwise look the name up from the referenced
   * institution. Returns null when neither is available.
   */
  private async resolveInstitutionName(
    userId: string,
    institutionId: string | undefined,
    institution: string | undefined,
  ): Promise<string | null> {
    if (institution && institution.trim()) {
      return institution.trim();
    }
    if (institutionId) {
      const found = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Institution).findOne({
          where: { id: institutionId, userId },
        }),
      );
      return found?.name ?? null;
    }
    return null;
  }

  async createLoanAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<CreatedLoanAccount> {
    const {
      openingBalance = 0,
      paymentMatching,
      paymentAmount,
      paymentFrequency,
      paymentStartDate,
      sourceAccountId,
      interestCategoryId,
      interestRate,
      institution,
      // A plain loan has no mortgage type (it amortizes on the loan engine).
      mortgageType: _mortgageType,
      prepaymentMode: _prepaymentMode,
      ...accountData
    } = createAccountDto;

    if (
      !paymentAmount ||
      !paymentFrequency ||
      !paymentStartDate ||
      !sourceAccountId
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.loanRequiredFields",
          "Loan accounts require paymentAmount, paymentFrequency, paymentStartDate, and sourceAccountId",
        ),
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException(
        tr(
          "errors.accounts.loanRequiresInterestRate",
          "Loan accounts require an interest rate",
        ),
      );
    }
    const institutionName = await this.resolveInstitutionName(
      userId,
      accountData.institutionId,
      institution,
    );
    if (!institutionName) {
      throw new BadRequestException(
        tr(
          "errors.accounts.loanRequiresInstitution",
          "Loan accounts require an institution name",
        ),
      );
    }
    // Refused before anything is written, as the rule create would refuse it.
    if (paymentMatching) {
      this.loanPaymentMatchingService.assertDefinable(
        sourceAccountId,
        paymentMatching,
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

    const savedAccount = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Account);
      const account = repo.create({
        ...accountData,
        userId,
        openingBalance: -loanAmount,
        currentBalance: -loanAmount,
        interestRate,
        institution,
        paymentAmount,
        paymentFrequency,
        // A TypeORM `date` column, serialized with local getters: a UTC-midnight
        // value is stored a day early west of Greenwich, and this date anchors
        // every amortization the account later computes.
        paymentStartDate: localDateForColumn(paymentStartDate),
        sourceAccountId,
        interestCategoryId: interestCatId || null,
      });
      return repo.save(account);
    });

    const endDateStr =
      // The same ceiling the end-date helpers date up to. Two literals
      // disagreed at the boundary: the util dated exactly 10000 while this
      // refused it, so one schedule had a payoff date and no scheduled end.
      amortization.totalPayments > 0 &&
      amortization.totalPayments <= MAX_DATEABLE_PAYMENTS
        ? formatDateYMD(amortization.endDate)
        : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: sourceAccountId,
        name: `Loan Payment - ${savedAccount.name}`,
        payeeName: institutionName,
        amount: -paymentAmount,
        currencyCode: accountData.currencyCode,
        // Through the loan-to-recurrence table rather than a cast. Every loan
        // frequency happens to share its spelling with a recurrence frequency
        // except SEMIMONTHLY, and a cast is exactly how that kind of mismatch
        // reaches the database unvalidated (`as any` skips class-validator: the
        // pipe only runs on controller input, and the column has no CHECK).
        frequency:
          FrequencyTypeDto[
            LOAN_FREQUENCY_TO_RECURRENCE[paymentFrequency as PaymentFrequency]
          ],
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
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).save(savedAccount),
    );

    return this.withPaymentMatching(userId, savedAccount, paymentMatching);
  }

  async createMortgageAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<CreatedLoanAccount> {
    const {
      openingBalance = 0,
      originalPrincipal,
      paymentMatching,
      mortgagePaymentFrequency,
      paymentStartDate,
      sourceAccountId,
      interestCategoryId,
      interestRate,
      institution,
      mortgageType: requestedType,
      prepaymentMode,
      isCanadianMortgage,
      isVariableRate,
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
        tr(
          "errors.accounts.mortgageRequiredFields",
          "Mortgage accounts require mortgagePaymentFrequency, paymentStartDate, sourceAccountId, and amortizationMonths",
        ),
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException(
        tr(
          "errors.accounts.mortgageRequiresInterestRate",
          "Mortgage accounts require an interest rate",
        ),
      );
    }
    const institutionName = await this.resolveInstitutionName(
      userId,
      accountData.institutionId,
      institution,
    );
    if (!institutionName) {
      throw new BadRequestException(
        tr(
          "errors.accounts.mortgageRequiresInstitution",
          "Mortgage accounts require an institution name",
        ),
      );
    }
    // Refused before anything is written, as the rule create would refuse it.
    if (paymentMatching) {
      this.loanPaymentMatchingService.assertDefinable(
        sourceAccountId,
        paymentMatching,
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

    // The type wins over the legacy flags; a request naming neither is the
    // default type, as the flags' `false` defaults always denoted.
    const mortgageType =
      requestedMortgageType({
        mortgageType: requestedType,
        isCanadianMortgage,
        isVariableRate,
      }) ?? "ANNUITY";
    const mortgageAmount = Math.abs(openingBalance);
    const amortizationInput: MortgageAmortizationInput = {
      principal: mortgageAmount,
      annualRate: interestRate,
      amortizationMonths,
      paymentFrequency: mortgagePaymentFrequency,
      mortgageType,
      startDate: new Date(paymentStartDate),
    };
    // Refuses a LINEAR or INTEREST_ONLY mortgage it cannot price (an
    // accelerated cadence, no principal) before anything is written.
    const amortization = calculateMortgageAmortization(amortizationInput);
    // LINEAR and INTEREST_ONLY have no constant payment to store (spec
    // decision 11); their template starts at the first installment, and every
    // later one is priced at its own due date.
    const storedPaymentAmount = storesConstantPayment(mortgageType)
      ? amortization.paymentAmount
      : null;
    // The amount originally borrowed, apart from the debt this ledger opens
    // at (spec section 14.3); the opening debt when the request names none.
    const storedOriginalPrincipal = originalPrincipal ?? mortgageAmount;
    // A LINEAR or INTEREST_ONLY first installment is table 4.3's at payment 1
    // on the opening debt, the price `nonAnnuityInstallment` gives every later
    // one: a LINEAR constant principal is the amount originally borrowed over
    // the payment count, which the preview's closed form cannot see when the
    // ledger starts after the loan did. `calculateMortgageAmortization` above
    // refused every term that leaves it unpriced, so null means an annuity.
    const methodInstallment = storesConstantPayment(mortgageType)
      ? null
      : nonAnnuityInstallment(
          mortgageType,
          {
            prepaymentMode: prepaymentModeColumn(mortgageType, prepaymentMode),
            originalPrincipal: storedOriginalPrincipal,
            openingBalance: -mortgageAmount,
            amortizationMonths,
            paymentStartDate,
            paymentFrequency: mortgagePaymentFrequency,
          },
          paymentStartDate,
          mortgageAmount,
          getPeriodicRate(
            interestRate,
            getMortgagePeriodsPerYear(mortgagePaymentFrequency),
            mortgageType,
          ),
        );
    const firstInstallment = methodInstallment
      ? {
          ...methodInstallment,
          total: roundMoney(
            methodInstallment.principal + methodInstallment.interest,
          ),
        }
      : {
          principal: amortization.principalPayment,
          interest: amortization.interestPayment,
          total: amortization.paymentAmount,
        };

    const termEndDate = termMonths
      ? mortgageTermEndDate(new Date(paymentStartDate), termMonths)
      : null;

    const savedAccount = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Account);
      const account = repo.create({
        ...accountData,
        userId,
        openingBalance: -mortgageAmount,
        currentBalance: -mortgageAmount,
        interestRate,
        institution,
        paymentAmount: storedPaymentAmount,
        paymentFrequency: mortgagePaymentFrequency,
        // A TypeORM `date` column, serialized with local getters: a UTC-midnight
        // value is stored a day early west of Greenwich, and this date anchors
        // every amortization the account later computes.
        paymentStartDate: localDateForColumn(paymentStartDate),
        sourceAccountId,
        interestCategoryId: interestCatId || null,
        ...mortgageTypeColumns(mortgageType),
        prepaymentMode: prepaymentModeColumn(mortgageType, prepaymentMode),
        termMonths: termMonths || null,
        termEndDate,
        amortizationMonths,
        originalPrincipal: storedOriginalPrincipal,
      });
      return repo.save(account);
    });

    // The one mortgage-to-recurrence table, shared with calculateMortgageEndDate
    // so the payoff date and the schedule that reaches it cannot disagree. It
    // used to be a local copy that mapped SEMI_MONTHLY to itself -- a value the
    // recurrence engine does not recognize, whose `default` returns the same
    // date, so the occurrence was due forever and the mortgage's payment
    // schedule never advanced. Migration 165 heals the rows that copy wrote.
    const scheduledFrequency =
      MORTGAGE_FREQUENCY_TO_RECURRENCE[mortgagePaymentFrequency];

    const endDateStr =
      // The same ceiling the end-date helpers date up to. Two literals
      // disagreed at the boundary: the util dated exactly 10000 while this
      // refused it, so one schedule had a payoff date and no scheduled end.
      amortization.totalPayments > 0 &&
      amortization.totalPayments <= MAX_DATEABLE_PAYMENTS
        ? formatDateYMD(amortization.endDate)
        : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: sourceAccountId,
        name: `Mortgage Payment - ${savedAccount.name}`,
        payeeName: institutionName,
        amount: -firstInstallment.total,
        currencyCode: accountData.currencyCode,
        frequency: FrequencyTypeDto[scheduledFrequency],
        nextDueDate: paymentStartDate,
        startDate: paymentStartDate,
        endDate: endDateStr,
        isActive: true,
        autoPost: false,
        splits: [
          {
            transferAccountId: savedAccount.id,
            amount: -firstInstallment.principal,
            memo: "Principal",
          },
          {
            categoryId: interestCatId || undefined,
            amount: -firstInstallment.interest,
            memo: "Interest",
          },
        ],
      },
    );

    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).save(savedAccount),
    );

    return this.withPaymentMatching(userId, savedAccount, paymentMatching);
  }

  previewMortgageAmortization(
    mortgageAmount: number,
    interestRate: number,
    amortizationMonths: number,
    paymentFrequency: MortgagePaymentFrequency,
    paymentStartDate: Date,
    mortgageType: MortgageType,
  ): MortgageAmortizationResult {
    return calculateMortgageAmortization({
      principal: Math.abs(mortgageAmount),
      annualRate: interestRate,
      amortizationMonths,
      paymentFrequency,
      mortgageType,
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

  /**
   * Suggest a mortgage type from installments the person read off a
   * statement. Pure: nothing is read or written.
   */
  detectMortgageTypeFromSamples(
    dto: DetectMortgageTypeDto,
  ): MortgageTypeDetection {
    return detectMortgageType(
      dto.samples,
      dto.interestRate ?? null,
      dto.paymentFrequency,
    );
  }

  /**
   * Suggest a mortgage type from the loan's own posted installments, paired
   * with their interest through the pairing rate-change inference reads
   * (`LoanPaymentDetectorService.buildInstallmentHistory`), each with the
   * ledger balance before its date. The rate is the one in effect on the
   * latest installment's date (`effectiveAnnualRateOn`), and only the
   * installments at that same rate are read, so a rate change inside the
   * window is not mistaken for a method. A suggestion: it writes nothing,
   * the stored type included.
   */
  async detectMortgageTypeFromHistory(
    account: Account,
    userId: string,
  ): Promise<MortgageTypeHistoryDetectionResponseDto> {
    if (account.accountType !== AccountType.MORTGAGE) {
      throw new BadRequestException(
        tr(
          "errors.accounts.onlyMortgageAccounts",
          "This operation is only valid for mortgage accounts",
        ),
      );
    }

    const { transactions, rateRows } = await withScopedDb(
      this.dataSource,
      async (m) => ({
        // The rows `current_balance` sums: no VOID row, no split child, none
        // dated after today. The pairing walks the balance back from
        // `current_balance` through these, so a row it does not count would
        // shift every balance before it, and a voided or future-dated
        // installment would be read as one the loan paid.
        transactions: await m
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .where("t.account_id = :accountId", { accountId: account.id })
          .andWhere("t.user_id = :userId", { userId })
          .andWhere(ledgerMovementPredicate("t"))
          .andWhere("t.transaction_date <= :today", { today: todayYMD() })
          .orderBy("t.transaction_date", "ASC")
          .getMany(),
        rateRows: await m.getRepository(LoanRateChange).find({
          where: { accountId: account.id, userId },
          order: { effectiveDate: "ASC" },
        }),
      }),
    );
    const history =
      await this.loanPaymentDetectorService.buildInstallmentHistory(
        userId,
        account,
        transactions,
      );

    const posted = postedInstallments(history);
    const latest = posted.length > 0 ? posted[posted.length - 1] : null;
    const fallbackRate =
      account.interestRate == null ? null : Number(account.interestRate);
    const quotedAnnualRate = latest
      ? effectiveAnnualRateOn(rateRows, latest.date, fallbackRate)
      : fallbackRate;
    // The trailing run at the latest rate, walked back from the newest: an
    // earlier period at the same rate (A, then B, then A again) is not
    // consecutive with it, and the shape rules read consecutive installments.
    const atLatestRate = (sample: DatedMortgageTypeSampleDto) =>
      effectiveAnnualRateOn(rateRows, sample.date, fallbackRate) ===
      quotedAnnualRate;
    let start = posted.length;
    while (
      start > 0 &&
      posted.length - start < HISTORY_DETECTION_SAMPLES &&
      atLatestRate(posted[start - 1])
    ) {
      start--;
    }
    const samples = posted.slice(start);
    const paymentFrequency = account.paymentFrequency
      ? toMortgagePaymentFrequency(account.paymentFrequency)
      : null;

    return {
      ...detectMortgageType(samples, quotedAnnualRate, paymentFrequency),
      quotedAnnualRate,
      paymentFrequency,
      samples,
    };
  }

  /**
   * Legacy mortgage-rate endpoint, now a thin wrapper over the rate-change
   * timeline: every call records a history row (finally persisting the
   * effective date) and, when no explicit payment is given, keeps the old
   * recalculate-to-hold-amortization default via recalculatePayment. No UI
   * asks here, so the scheduled bill's sync is applied at once, through the
   * same apply the confirmation prompt uses: the template is priced at its
   * own due date and `accounts.payment_amount` is not written
   * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.5).
   */
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
        tr(
          "errors.accounts.onlyMortgageAccounts",
          "This operation is only valid for mortgage accounts",
        ),
      );
    }

    if (account.isClosed) {
      throw new BadRequestException(
        tr(
          "errors.accounts.updateRateClosed",
          "Cannot update rate on a closed account",
        ),
      );
    }

    // A LINEAR or INTEREST_ONLY mortgage's method states every installment,
    // so a stated payment is refused before anything is read or written
    // (spec section 5.3).
    refuseStatedPayment(account, newPaymentAmount);
    const derivedType = derivedInstallmentType(account);
    if (derivedType !== null) {
      assertMortgageMethodTerms(derivedType, account);
    }

    // The debt the new rate first applies to: the ledger through the
    // effective date, the as-of read installment pricing uses (spec decision
    // 5). `current_balance` stops at today, so a future-dated change would be
    // priced against a debt that payments posted before it no longer owe.
    // Read before the rate change is recorded, so an unreadable ledger refuses
    // the request before anything is written.
    const effectiveYmd = formatDateYMD(effectiveDate);
    const debt = await withScopedDb(this.dataSource, (m) =>
      datedLoanDebt(m, account, effectiveYmd),
    );
    if (debt === null) {
      throw new ServiceUnavailableException(
        tr(
          "errors.accounts.loanLedgerUnreadable",
          "This loan's balance could not be read. Try again.",
        ),
      );
    }

    const rateChange = await this.loanRateChangesService.create(
      userId,
      account.id,
      {
        effectiveDate: effectiveYmd,
        annualRate: newRate,
        newPaymentAmount: newPaymentAmount ?? null,
        recalculatePayment: newPaymentAmount == null,
      },
    );
    // Best-effort, as this flow has always been: the rate history is already
    // committed, and the template is what the next posting reprices at the
    // consumption boundary anyway (INV-LOAN-006).
    try {
      await this.loanRateChangesService.applyScheduledPaymentSync(
        userId,
        account.id,
      );
    } catch (error) {
      this.logger.warn(
        `Could not sync the scheduled payment of mortgage ${account.id} after its rate update: ${error.message}`,
      );
    }

    const periodicRate = getPeriodicRate(
      newRate,
      // The STORED cadence, read through the lookup that knows both spellings.
      // Casting it to MortgagePaymentFrequency and asking
      // getMortgagePeriodsPerYear turned SEMIMONTHLY into its monthly default,
      // so a semi-monthly mortgage's posted split carried twice the interest.
      periodsPerYearForStoredFrequency(account.paymentFrequency) ??
        DEFAULT_PERIODS_PER_YEAR,
      mortgageTypeOf(account),
    );

    // The method's installment at the effective date: principal from table
    // 4.3 on the dated debt, interest at the new rate (spec section 5.3).
    // `assertMortgageMethodTerms` above refused every account that leaves it
    // unpriced.
    if (derivedType !== null) {
      const installment = nonAnnuityInstallment(
        derivedType,
        account,
        effectiveYmd,
        debt,
        periodicRate,
      )!;
      return {
        newRate,
        paymentAmount: roundMoney(installment.principal + installment.interest),
        principalPayment: installment.principal,
        interestPayment: installment.interest,
        effectiveDate: rateChange.effectiveDate,
      };
    }

    const paymentAmount =
      rateChange.newPaymentAmount ?? (Number(account.paymentAmount) || 0);
    const interestPayment = roundMoney(debt * periodicRate);
    const principalPayment = roundMoney(paymentAmount - interestPayment);

    return {
      newRate,
      paymentAmount,
      principalPayment,
      interestPayment,
      effectiveDate: rateChange.effectiveDate,
    };
  }
}

/**
 * Each payment that carries both a principal and an interest figure, as a
 * dated sample with the balance owed before its date. Where interest is a
 * separate expense the payment's own amount is its principal; a payment with
 * no interest figure (a lump-sum repayment, a transfer without a split) says
 * nothing about the method and is left out.
 */
function postedInstallments(
  history: InstallmentHistory,
): DatedMortgageTypeSampleDto[] {
  const samples: DatedMortgageTypeSampleDto[] = [];
  for (const payment of history.payments) {
    if (payment.interestAmount == null) continue;
    const principal =
      payment.principalAmount ??
      (history.interestBookedSeparately ? payment.amount : null);
    if (principal == null) continue;
    const date = payment.date.split("T")[0];
    const balance = history.balanceMap.get(date);
    samples.push({
      date,
      principal: roundMoney(principal),
      interest: roundMoney(payment.interestAmount),
      balanceBefore:
        balance !== undefined && balance > 0 ? roundMoney(balance) : null,
    });
  }
  return samples;
}
