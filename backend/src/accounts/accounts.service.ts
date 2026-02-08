import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account, AccountType, AccountSubType } from './entities/account.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { InvestmentTransaction } from '../securities/entities/investment-transaction.entity';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { CategoriesService } from '../categories/categories.service';
import { ScheduledTransactionsService } from '../scheduled-transactions/scheduled-transactions.service';
import { NetWorthService } from '../net-worth/net-worth.service';
import {
  calculateAmortization,
  PaymentFrequency,
  AmortizationResult,
} from './loan-amortization.util';
import {
  calculateMortgageAmortization,
  recalculateMortgageAfterRateChange,
  getMortgagePeriodsPerYear,
  MortgagePaymentFrequency,
  MortgageAmortizationInput,
  MortgageAmortizationResult,
} from './mortgage-amortization.util';
import { MortgagePaymentFrequency as DtoMortgagePaymentFrequency } from './dto/create-account.dto';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionRepository: Repository<InvestmentTransaction>,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
  ) {}

  /**
   * Create a new account for a user
   */
  async create(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account | { cashAccount: Account; brokerageAccount: Account }> {
    const { openingBalance = 0, createInvestmentPair, ...accountData } = createAccountDto;

    // If creating an investment account pair, delegate to the pair creation method
    if (
      createInvestmentPair &&
      accountData.accountType === AccountType.INVESTMENT
    ) {
      return this.createInvestmentAccountPair(userId, createAccountDto);
    }

    // If creating a loan account with payment details, delegate to loan creation method
    if (
      accountData.accountType === AccountType.LOAN &&
      createAccountDto.paymentAmount &&
      createAccountDto.paymentFrequency &&
      createAccountDto.paymentStartDate &&
      createAccountDto.sourceAccountId
    ) {
      return this.createLoanAccount(userId, createAccountDto);
    }

    // If creating a mortgage account with payment details, delegate to mortgage creation method
    if (
      accountData.accountType === AccountType.MORTGAGE &&
      createAccountDto.mortgagePaymentFrequency &&
      createAccountDto.paymentStartDate &&
      createAccountDto.sourceAccountId &&
      createAccountDto.amortizationMonths
    ) {
      return this.createMortgageAccount(userId, createAccountDto);
    }

    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance,
      currentBalance: openingBalance,
    });

    return this.accountsRepository.save(account);
  }

  /**
   * Create a linked investment account pair (cash + brokerage)
   */
  async createInvestmentAccountPair(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<{ cashAccount: Account; brokerageAccount: Account }> {
    const { openingBalance = 0, name, ...accountData } = createAccountDto;

    // Create the cash account first
    const cashAccount = this.accountsRepository.create({
      ...accountData,
      name: `${name} - Cash`,
      userId,
      openingBalance,
      currentBalance: openingBalance,
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    await this.accountsRepository.save(cashAccount);

    // Create the brokerage account linked to the cash account
    const brokerageAccount = this.accountsRepository.create({
      ...accountData,
      name: `${name} - Brokerage`,
      userId,
      openingBalance: 0,
      currentBalance: 0,
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cashAccount.id,
    });
    await this.accountsRepository.save(brokerageAccount);

    // Update cash account to link back to brokerage
    cashAccount.linkedAccountId = brokerageAccount.id;
    await this.accountsRepository.save(cashAccount);

    return { cashAccount, brokerageAccount };
  }

  /**
   * Find all accounts for a user
   */
  async findAll(userId: string, includeInactive = false): Promise<(Account & { canDelete?: boolean })[]> {
    const queryBuilder = this.accountsRepository
      .createQueryBuilder('account')
      .where('account.userId = :userId', { userId })
      .orderBy('account.createdAt', 'DESC');

    if (!includeInactive) {
      queryBuilder.andWhere('account.isClosed = :isClosed', { isClosed: false });
    }

    const accounts = await queryBuilder.getMany();

    if (accounts.length === 0) return [];

    // Batch check deletability: count transactions + investment transactions per account in 2 queries
    const accountIds = accounts.map(a => a.id);

    const [txCounts, invTxCounts] = await Promise.all([
      this.transactionRepository
        .createQueryBuilder('t')
        .select('t.accountId', 'accountId')
        .addSelect('COUNT(t.id)', 'cnt')
        .where('t.accountId IN (:...accountIds)', { accountIds })
        .groupBy('t.accountId')
        .getRawMany(),
      this.investmentTransactionRepository
        .createQueryBuilder('it')
        .select('it.accountId', 'accountId')
        .addSelect('COUNT(it.id)', 'cnt')
        .where('it.accountId IN (:...accountIds)', { accountIds })
        .groupBy('it.accountId')
        .getRawMany(),
    ]);

    const txCountMap = new Map<string, number>();
    for (const row of txCounts) txCountMap.set(row.accountId, parseInt(row.cnt, 10));
    const invTxCountMap = new Map<string, number>();
    for (const row of invTxCounts) invTxCountMap.set(row.accountId, parseInt(row.cnt, 10));

    return accounts.map(account => ({
      ...account,
      canDelete: !(txCountMap.get(account.id) || 0) && !(invTxCountMap.get(account.id) || 0),
    }));
  }

  /**
   * Find a single account by ID
   */
  async findOne(userId: string, id: string): Promise<Account> {
    const account = await this.accountsRepository.findOne({
      where: { id },
    });

    if (!account) {
      throw new NotFoundException(`Account with ID ${id} not found`);
    }

    // Ensure the account belongs to the user
    if (account.userId !== userId) {
      throw new ForbiddenException('Access denied to this account');
    }

    return account;
  }

  /**
   * Get the linked investment account pair for a given account ID
   */
  async getInvestmentAccountPair(
    userId: string,
    accountId: string,
  ): Promise<{ cashAccount: Account; brokerageAccount: Account }> {
    const account = await this.findOne(userId, accountId);

    // Check if this is an investment account with a sub-type
    if (
      account.accountType !== AccountType.INVESTMENT ||
      !account.accountSubType
    ) {
      throw new BadRequestException(
        'This account is not part of an investment account pair',
      );
    }

    // Get the linked account
    if (!account.linkedAccountId) {
      throw new BadRequestException(
        'This investment account does not have a linked account',
      );
    }

    const linkedAccount = await this.findOne(userId, account.linkedAccountId);

    // Return in correct order based on sub-type
    if (account.accountSubType === AccountSubType.INVESTMENT_CASH) {
      return { cashAccount: account, brokerageAccount: linkedAccount };
    } else {
      return { cashAccount: linkedAccount, brokerageAccount: account };
    }
  }

  /**
   * Create a loan account with automatic scheduled payment setup
   */
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

    // Validate required loan fields
    if (!paymentAmount || !paymentFrequency || !paymentStartDate || !sourceAccountId) {
      throw new BadRequestException(
        'Loan accounts require paymentAmount, paymentFrequency, paymentStartDate, and sourceAccountId',
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException('Loan accounts require an interest rate');
    }
    if (!institution) {
      throw new BadRequestException('Loan accounts require an institution name');
    }

    // Verify source account belongs to user
    await this.findOne(userId, sourceAccountId);

    // Get loan categories (Loan Interest for interest portion)
    // Principal portion will be a transfer to the loan account
    let interestCatId = interestCategoryId;

    if (!interestCatId) {
      const { interestCategory } = await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCatId = interestCategory.id;
      }
    }

    // Calculate amortization for end date and first payment split
    // User enters loan amount as positive, we store as negative (liability)
    const loanAmount = Math.abs(openingBalance);
    const amortization = calculateAmortization(
      loanAmount,
      interestRate,
      paymentAmount,
      paymentFrequency as PaymentFrequency,
      new Date(paymentStartDate),
    );

    // Create the loan account with negative balance (liability)
    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance: -loanAmount, // Store as negative
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

    // Create scheduled transaction for loan payments
    // Total payment amount is negative (outflow from source account)
    const endDateStr = amortization.totalPayments > 0 && amortization.totalPayments < 10000
      ? amortization.endDate.toISOString().split('T')[0]
      : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(userId, {
      accountId: sourceAccountId,
      name: `Loan Payment - ${savedAccount.name}`,
      payeeName: institution,
      amount: -paymentAmount, // Negative outflow from source account
      currencyCode: accountData.currencyCode,
      frequency: paymentFrequency as any,
      nextDueDate: paymentStartDate,
      startDate: paymentStartDate,
      endDate: endDateStr,
      isActive: true,
      autoPost: false,
      splits: [
        {
          // Transfer to loan account (reduces debt)
          // Amount is negative as part of the total outflow
          transferAccountId: savedAccount.id,
          amount: -amortization.principalPayment,
          memo: 'Principal',
        },
        {
          // Interest expense
          categoryId: interestCatId || undefined,
          amount: -amortization.interestPayment,
          memo: 'Interest',
        },
      ],
    });

    // Update account with scheduled transaction reference
    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await this.accountsRepository.save(savedAccount);

    return savedAccount;
  }

  /**
   * Create a mortgage account with automatic scheduled payment setup
   * Supports Canadian mortgages with semi-annual compounding and accelerated payments
   */
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

    // Validate required mortgage fields
    if (!mortgagePaymentFrequency || !paymentStartDate || !sourceAccountId || !amortizationMonths) {
      throw new BadRequestException(
        'Mortgage accounts require mortgagePaymentFrequency, paymentStartDate, sourceAccountId, and amortizationMonths',
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException('Mortgage accounts require an interest rate');
    }
    if (!institution) {
      throw new BadRequestException('Mortgage accounts require an institution name');
    }

    // Verify source account belongs to user
    await this.findOne(userId, sourceAccountId);

    // Get mortgage interest category
    let interestCatId = interestCategoryId;

    if (!interestCatId) {
      // Try to find mortgage interest category, fall back to loan interest
      const { interestCategory } = await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCatId = interestCategory.id;
      }
    }

    // Calculate mortgage amortization
    // User enters mortgage amount as positive, we store as negative (liability)
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

    // Calculate term end date if term is specified
    let termEndDate: Date | null = null;
    if (termMonths) {
      termEndDate = new Date(paymentStartDate);
      termEndDate.setMonth(termEndDate.getMonth() + termMonths);
    }

    // Create the mortgage account with negative balance (liability)
    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance: -mortgageAmount, // Store as negative
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

    // Map mortgage payment frequency to scheduled transaction frequency
    // Accelerated frequencies use the base frequency for scheduling
    const frequencyMap: Record<string, string> = {
      MONTHLY: 'MONTHLY',
      SEMI_MONTHLY: 'SEMI_MONTHLY',
      BIWEEKLY: 'BIWEEKLY',
      ACCELERATED_BIWEEKLY: 'BIWEEKLY',
      WEEKLY: 'WEEKLY',
      ACCELERATED_WEEKLY: 'WEEKLY',
    };
    const scheduledFrequency = frequencyMap[mortgagePaymentFrequency] || 'MONTHLY';

    // Create scheduled transaction for mortgage payments
    const endDateStr = amortization.totalPayments > 0 && amortization.totalPayments < 10000
      ? amortization.endDate.toISOString().split('T')[0]
      : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(userId, {
      accountId: sourceAccountId,
      name: `Mortgage Payment - ${savedAccount.name}`,
      payeeName: institution,
      amount: -amortization.paymentAmount, // Negative outflow from source account
      currencyCode: accountData.currencyCode,
      frequency: scheduledFrequency as any,
      nextDueDate: paymentStartDate,
      startDate: paymentStartDate,
      endDate: endDateStr,
      isActive: true,
      autoPost: false,
      splits: [
        {
          // Transfer to mortgage account (reduces debt)
          transferAccountId: savedAccount.id,
          amount: -amortization.principalPayment,
          memo: 'Principal',
        },
        {
          // Interest expense
          categoryId: interestCatId || undefined,
          amount: -amortization.interestPayment,
          memo: 'Interest',
        },
      ],
    });

    // Update account with scheduled transaction reference
    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await this.accountsRepository.save(savedAccount);

    return savedAccount;
  }

  /**
   * Preview mortgage amortization without creating an account
   */
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

  /**
   * Update mortgage interest rate and optionally payment amount
   */
  async updateMortgageRate(
    userId: string,
    accountId: string,
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
    const account = await this.findOne(userId, accountId);

    if (account.accountType !== AccountType.MORTGAGE) {
      throw new BadRequestException('This operation is only valid for mortgage accounts');
    }

    if (account.isClosed) {
      throw new BadRequestException('Cannot update rate on a closed account');
    }

    // Get current balance (remaining principal)
    const currentBalance = Math.abs(Number(account.currentBalance));

    // Calculate remaining amortization months
    // Estimate based on payments made since start
    const startDate = account.paymentStartDate || new Date();
    const monthsElapsed = Math.floor(
      (effectiveDate.getTime() - startDate.getTime()) / (30 * 24 * 60 * 60 * 1000)
    );
    const remainingAmortizationMonths = Math.max(
      12,
      (account.amortizationMonths || 300) - monthsElapsed
    );

    // Recalculate payment if not manually specified
    let paymentAmount: number;
    let principalPayment: number;
    let interestPayment: number;

    if (newPaymentAmount) {
      // User specified new payment amount
      paymentAmount = newPaymentAmount;

      // Calculate principal/interest split at new rate
      const periodsPerYear = getMortgagePeriodsPerYear(
        (account.paymentFrequency || 'MONTHLY') as MortgagePaymentFrequency
      );
      const isCanadian = account.isCanadianMortgage || false;
      const isVariable = account.isVariableRate || false;

      // Simple calculation for first payment split
      let periodicRate: number;
      if (isCanadian && !isVariable) {
        const semiAnnualRate = newRate / 100 / 2;
        periodicRate = Math.pow(1 + semiAnnualRate, 2 / periodsPerYear) - 1;
      } else {
        periodicRate = newRate / 100 / periodsPerYear;
      }

      interestPayment = Math.round(currentBalance * periodicRate * 100) / 100;
      principalPayment = Math.round((paymentAmount - interestPayment) * 100) / 100;
    } else {
      // Auto-calculate new payment based on remaining amortization
      const result = recalculateMortgageAfterRateChange(
        currentBalance,
        newRate,
        remainingAmortizationMonths,
        (account.paymentFrequency || 'MONTHLY') as MortgagePaymentFrequency,
        account.isCanadianMortgage || false,
        account.isVariableRate || false,
      );

      paymentAmount = result.paymentAmount;
      principalPayment = result.principalPayment;
      interestPayment = result.interestPayment;
    }

    // Update account
    account.interestRate = newRate;
    account.paymentAmount = paymentAmount;
    await this.accountsRepository.save(account);

    // Update scheduled transaction if exists
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
                memo: 'Principal',
              },
              {
                categoryId: account.interestCategoryId || undefined,
                amount: -interestPayment,
                memo: 'Interest',
              },
            ],
          },
        );
      } catch (error) {
        this.logger.warn(`Could not update scheduled transaction: ${error.message}`);
      }
    }

    return {
      newRate,
      paymentAmount,
      principalPayment,
      interestPayment,
      effectiveDate: effectiveDate.toISOString().split('T')[0],
    };
  }

  /**
   * Preview loan amortization without creating an account
   */
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
   * Update an account
   */
  async update(
    userId: string,
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<Account> {
    const account = await this.findOne(userId, id);

    if (account.isClosed) {
      throw new BadRequestException('Cannot update a closed account');
    }

    // If openingBalance is being changed, we need to recalculate currentBalance
    // currentBalance = openingBalance + sum(all transaction amounts)
    if (
      updateAccountDto.openingBalance !== undefined &&
      updateAccountDto.openingBalance !== account.openingBalance
    ) {
      const oldOpeningBalance = Number(account.openingBalance) || 0;
      const newOpeningBalance = Number(updateAccountDto.openingBalance) || 0;
      const difference = newOpeningBalance - oldOpeningBalance;

      // Adjust currentBalance by the difference
      account.currentBalance =
        Math.round((Number(account.currentBalance) + difference) * 100) / 100;
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (updateAccountDto.name !== undefined) account.name = updateAccountDto.name;
    if (updateAccountDto.accountType !== undefined) account.accountType = updateAccountDto.accountType;
    if (updateAccountDto.currencyCode !== undefined) account.currencyCode = updateAccountDto.currencyCode;
    if (updateAccountDto.openingBalance !== undefined) account.openingBalance = updateAccountDto.openingBalance;
    if (updateAccountDto.description !== undefined) account.description = updateAccountDto.description;
    if (updateAccountDto.accountNumber !== undefined) account.accountNumber = updateAccountDto.accountNumber;
    if (updateAccountDto.institution !== undefined) account.institution = updateAccountDto.institution;
    if (updateAccountDto.creditLimit !== undefined) account.creditLimit = updateAccountDto.creditLimit;
    if (updateAccountDto.interestRate !== undefined) account.interestRate = updateAccountDto.interestRate;
    if (updateAccountDto.isFavourite !== undefined) account.isFavourite = updateAccountDto.isFavourite;
    if (updateAccountDto.paymentAmount !== undefined) account.paymentAmount = updateAccountDto.paymentAmount;
    if (updateAccountDto.paymentFrequency !== undefined) account.paymentFrequency = updateAccountDto.paymentFrequency;
    if (updateAccountDto.paymentStartDate !== undefined) account.paymentStartDate = updateAccountDto.paymentStartDate ? new Date(updateAccountDto.paymentStartDate) : null;
    if (updateAccountDto.sourceAccountId !== undefined) account.sourceAccountId = updateAccountDto.sourceAccountId;
    if (updateAccountDto.principalCategoryId !== undefined) account.principalCategoryId = updateAccountDto.principalCategoryId;
    if (updateAccountDto.interestCategoryId !== undefined) account.interestCategoryId = updateAccountDto.interestCategoryId;
    if (updateAccountDto.assetCategoryId !== undefined) account.assetCategoryId = updateAccountDto.assetCategoryId;
    if (updateAccountDto.dateAcquired !== undefined) account.dateAcquired = updateAccountDto.dateAcquired ? new Date(updateAccountDto.dateAcquired) : null;
    // Mortgage-specific fields
    if (updateAccountDto.isCanadianMortgage !== undefined) account.isCanadianMortgage = updateAccountDto.isCanadianMortgage;
    if (updateAccountDto.isVariableRate !== undefined) account.isVariableRate = updateAccountDto.isVariableRate;
    if (updateAccountDto.termMonths !== undefined) account.termMonths = updateAccountDto.termMonths;
    if (updateAccountDto.amortizationMonths !== undefined) account.amortizationMonths = updateAccountDto.amortizationMonths;

    const savedAccount = await this.accountsRepository.save(account);

    // If currency changed on an investment account, update the linked account too
    if (
      updateAccountDto.currencyCode !== undefined &&
      account.linkedAccountId &&
      account.accountType === AccountType.INVESTMENT
    ) {
      const linkedAccount = await this.accountsRepository.findOne({
        where: { id: account.linkedAccountId, userId },
      });
      if (linkedAccount) {
        linkedAccount.currencyCode = updateAccountDto.currencyCode;
        await this.accountsRepository.save(linkedAccount);
      }
    }

    // Trigger net worth recalculation if balance-affecting fields changed
    const needsRecalc =
      updateAccountDto.openingBalance !== undefined ||
      updateAccountDto.dateAcquired !== undefined;
    if (needsRecalc) {
      this.netWorthService.recalculateAccount(userId, id).catch((err) =>
        this.logger.warn(
          `Net worth recalc failed for account ${id}: ${err.message}`,
        ),
      );
    }

    return savedAccount;
  }

  /**
   * Close an account (soft delete)
   */
  async close(userId: string, id: string): Promise<Account> {
    const account = await this.findOne(userId, id);

    if (account.isClosed) {
      throw new BadRequestException('Account is already closed');
    }

    // Check if balance is not zero
    if (Number(account.currentBalance) !== 0) {
      throw new BadRequestException(
        'Cannot close account with non-zero balance. Current balance: ' +
          account.currentBalance,
      );
    }

    account.isClosed = true;
    account.closedDate = new Date();

    const saved = await this.accountsRepository.save(account);

    // If this is an investment cash account, also close the linked brokerage account
    if (account.accountSubType === AccountSubType.INVESTMENT_CASH && account.linkedAccountId) {
      const brokerageAccount = await this.accountsRepository.findOne({
        where: { id: account.linkedAccountId, userId },
      });
      if (brokerageAccount && !brokerageAccount.isClosed) {
        brokerageAccount.isClosed = true;
        brokerageAccount.closedDate = new Date();
        await this.accountsRepository.save(brokerageAccount);
      }
    }

    return saved;
  }

  /**
   * Reopen a closed account
   */
  async reopen(userId: string, id: string): Promise<Account> {
    const account = await this.findOne(userId, id);

    if (!account.isClosed) {
      throw new BadRequestException('Account is not closed');
    }

    account.isClosed = false;
    account.closedDate = null;

    const saved = await this.accountsRepository.save(account);

    // If this is an investment cash account, also reopen the linked brokerage account
    if (account.accountSubType === AccountSubType.INVESTMENT_CASH && account.linkedAccountId) {
      const brokerageAccount = await this.accountsRepository.findOne({
        where: { id: account.linkedAccountId, userId },
      });
      if (brokerageAccount && brokerageAccount.isClosed) {
        brokerageAccount.isClosed = false;
        brokerageAccount.closedDate = null;
        await this.accountsRepository.save(brokerageAccount);
      }
    }

    return saved;
  }

  /**
   * Get the current balance of an account
   */
  async getBalance(userId: string, id: string): Promise<{ balance: number }> {
    const account = await this.findOne(userId, id);
    return { balance: account.currentBalance };
  }

  /**
   * Update account balance (called internally by transactions)
   */
  async updateBalance(
    accountId: string,
    amount: number,
  ): Promise<Account> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException(`Account with ID ${accountId} not found`);
    }

    if (account.isClosed) {
      throw new BadRequestException('Cannot modify balance of a closed account');
    }

    // Round to 2 decimal places to avoid floating-point precision errors
    account.currentBalance =
      Math.round((Number(account.currentBalance) + Number(amount)) * 100) / 100;
    return this.accountsRepository.save(account);
  }

  /**
   * Get account summary statistics for a user
   */
  async getSummary(userId: string): Promise<{
    totalAccounts: number;
    totalBalance: number;
    totalAssets: number;
    totalLiabilities: number;
    netWorth: number;
  }> {
    const accounts = await this.findAll(userId, false);

    const assetTypes = ['CHEQUING', 'SAVINGS', 'INVESTMENT', 'CASH', 'ASSET'];
    const liabilityTypes = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

    let totalBalance = 0;
    let totalAssets = 0;
    let totalLiabilities = 0;

    accounts.forEach((account) => {
      const balance = Number(account.currentBalance);
      totalBalance += balance;

      if (assetTypes.includes(account.accountType)) {
        totalAssets += balance;
      } else if (liabilityTypes.includes(account.accountType)) {
        // Liabilities are typically negative or stored as positive but represent debt
        totalLiabilities += Math.abs(balance);
      }
    });

    return {
      totalAccounts: accounts.length,
      totalBalance,
      totalAssets,
      totalLiabilities,
      netWorth: totalAssets - totalLiabilities,
    };
  }

  /**
   * Get transaction count for an account (regular and investment transactions)
   */
  async getTransactionCount(
    userId: string,
    accountId: string,
  ): Promise<{ transactionCount: number; investmentTransactionCount: number; canDelete: boolean }> {
    // Verify account belongs to user
    await this.findOne(userId, accountId);

    const transactionCount = await this.transactionRepository.count({
      where: { accountId },
    });

    const investmentTransactionCount = await this.investmentTransactionRepository.count({
      where: { accountId },
    });

    return {
      transactionCount,
      investmentTransactionCount,
      canDelete: transactionCount === 0 && investmentTransactionCount === 0,
    };
  }

  /**
   * Permanently delete an account (only if it has no transactions)
   */
  async delete(userId: string, id: string): Promise<void> {
    const account = await this.findOne(userId, id);

    // Check for regular transactions
    const transactionCount = await this.transactionRepository.count({
      where: { accountId: id },
    });

    if (transactionCount > 0) {
      throw new BadRequestException(
        `Cannot delete account with ${transactionCount} transaction(s). Close the account instead.`,
      );
    }

    // Check for investment transactions
    const investmentTransactionCount = await this.investmentTransactionRepository.count({
      where: { accountId: id },
    });

    if (investmentTransactionCount > 0) {
      throw new BadRequestException(
        `Cannot delete account with ${investmentTransactionCount} investment transaction(s). Close the account instead.`,
      );
    }

    // If this is part of an investment account pair, remove the link from the paired account
    if (account.linkedAccountId) {
      const linkedAccount = await this.accountsRepository.findOne({
        where: { id: account.linkedAccountId },
      });
      if (linkedAccount) {
        linkedAccount.linkedAccountId = null;
        await this.accountsRepository.save(linkedAccount);
      }
    }

    // If this is a loan or mortgage account with an associated scheduled transaction, delete it
    if (
      (account.accountType === AccountType.LOAN || account.accountType === AccountType.MORTGAGE) &&
      account.scheduledTransactionId
    ) {
      try {
        await this.scheduledTransactionsService.remove(userId, account.scheduledTransactionId);
      } catch (error) {
        // Scheduled transaction may have already been deleted, continue with account deletion
        this.logger.warn(`Could not delete scheduled transaction ${account.scheduledTransactionId}: ${error.message}`);
      }
    }

    await this.accountsRepository.remove(account);
  }

  /**
   * Reset all brokerage account balances to 0 for a user.
   * Used when clearing investment data for re-import.
   */
  async resetBrokerageBalances(userId: string): Promise<number> {
    const brokerageAccounts = await this.accountsRepository.find({
      where: {
        userId,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      },
    });

    for (const account of brokerageAccounts) {
      account.currentBalance = 0;
      await this.accountsRepository.save(account);
    }

    return brokerageAccounts.length;
  }
}
