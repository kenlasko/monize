import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  Account,
  AccountType,
  AccountSubType,
} from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { PaymentFrequency, AmortizationResult } from "./loan-amortization.util";
import {
  MortgagePaymentFrequency,
  MortgageAmortizationResult,
} from "./mortgage-amortization.util";

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
    private loanMortgageService: LoanMortgageAccountService,
  ) {}

  /**
   * Create a new account for a user
   */
  async create(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account | { cashAccount: Account; brokerageAccount: Account }> {
    const {
      openingBalance = 0,
      createInvestmentPair,
      ...accountData
    } = createAccountDto;

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
  async findAll(
    userId: string,
    includeInactive = false,
  ): Promise<(Account & { canDelete?: boolean })[]> {
    const queryBuilder = this.accountsRepository
      .createQueryBuilder("account")
      .where("account.userId = :userId", { userId })
      .orderBy("account.createdAt", "DESC");

    if (!includeInactive) {
      queryBuilder.andWhere("account.isClosed = :isClosed", {
        isClosed: false,
      });
    }

    const accounts = await queryBuilder.getMany();

    if (accounts.length === 0) return [];

    // Batch check deletability: count transactions + investment transactions per account in 2 queries
    const accountIds = accounts.map((a) => a.id);

    const [txCounts, invTxCounts] = await Promise.all([
      this.transactionRepository
        .createQueryBuilder("t")
        .select("t.accountId", "accountId")
        .addSelect("COUNT(t.id)", "cnt")
        .where("t.accountId IN (:...accountIds)", { accountIds })
        .groupBy("t.accountId")
        .getRawMany(),
      this.investmentTransactionRepository
        .createQueryBuilder("it")
        .select("it.accountId", "accountId")
        .addSelect("COUNT(it.id)", "cnt")
        .where("it.accountId IN (:...accountIds)", { accountIds })
        .groupBy("it.accountId")
        .getRawMany(),
    ]);

    const txCountMap = new Map<string, number>();
    for (const row of txCounts)
      txCountMap.set(row.accountId, parseInt(row.cnt, 10));
    const invTxCountMap = new Map<string, number>();
    for (const row of invTxCounts)
      invTxCountMap.set(row.accountId, parseInt(row.cnt, 10));

    return accounts.map((account) => ({
      ...account,
      canDelete:
        !(txCountMap.get(account.id) || 0) &&
        !(invTxCountMap.get(account.id) || 0),
    }));
  }

  /**
   * Find a single account by ID
   */
  async findOne(userId: string, id: string): Promise<Account> {
    const account = await this.accountsRepository.findOne({
      where: { id, userId },
    });

    if (!account) {
      throw new NotFoundException(`Account with ID ${id} not found`);
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
        "This account is not part of an investment account pair",
      );
    }

    // Get the linked account
    if (!account.linkedAccountId) {
      throw new BadRequestException(
        "This investment account does not have a linked account",
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

  async createLoanAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
    await this.findOne(userId, createAccountDto.sourceAccountId!);
    return this.loanMortgageService.createLoanAccount(userId, createAccountDto);
  }

  async createMortgageAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
    await this.findOne(userId, createAccountDto.sourceAccountId!);
    return this.loanMortgageService.createMortgageAccount(
      userId,
      createAccountDto,
    );
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
    return this.loanMortgageService.previewMortgageAmortization(
      mortgageAmount,
      interestRate,
      amortizationMonths,
      paymentFrequency,
      paymentStartDate,
      isCanadian,
      isVariableRate,
    );
  }

  async updateMortgageRate(
    userId: string,
    accountId: string,
    newRate: number,
    effectiveDate: Date,
    newPaymentAmount?: number,
  ) {
    const account = await this.findOne(userId, accountId);
    return this.loanMortgageService.updateMortgageRate(
      account,
      userId,
      newRate,
      effectiveDate,
      newPaymentAmount,
    );
  }

  previewLoanAmortization(
    loanAmount: number,
    interestRate: number,
    paymentAmount: number,
    paymentFrequency: PaymentFrequency,
    paymentStartDate: Date,
  ): AmortizationResult {
    return this.loanMortgageService.previewLoanAmortization(
      loanAmount,
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
      throw new BadRequestException("Cannot update a closed account");
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
    if (updateAccountDto.name !== undefined)
      account.name = updateAccountDto.name;
    if (updateAccountDto.accountType !== undefined)
      account.accountType = updateAccountDto.accountType;
    if (updateAccountDto.currencyCode !== undefined)
      account.currencyCode = updateAccountDto.currencyCode;
    if (updateAccountDto.openingBalance !== undefined)
      account.openingBalance = updateAccountDto.openingBalance;
    if (updateAccountDto.description !== undefined)
      account.description = updateAccountDto.description;
    if (updateAccountDto.accountNumber !== undefined)
      account.accountNumber = updateAccountDto.accountNumber;
    if (updateAccountDto.institution !== undefined)
      account.institution = updateAccountDto.institution;
    if (updateAccountDto.creditLimit !== undefined)
      account.creditLimit = updateAccountDto.creditLimit;
    if (updateAccountDto.interestRate !== undefined)
      account.interestRate = updateAccountDto.interestRate;
    if (updateAccountDto.isFavourite !== undefined)
      account.isFavourite = updateAccountDto.isFavourite;
    if (updateAccountDto.paymentAmount !== undefined)
      account.paymentAmount = updateAccountDto.paymentAmount;
    if (updateAccountDto.paymentFrequency !== undefined)
      account.paymentFrequency = updateAccountDto.paymentFrequency;
    if (updateAccountDto.paymentStartDate !== undefined)
      account.paymentStartDate = updateAccountDto.paymentStartDate
        ? new Date(updateAccountDto.paymentStartDate)
        : null;
    if (updateAccountDto.sourceAccountId !== undefined)
      account.sourceAccountId = updateAccountDto.sourceAccountId;
    if (updateAccountDto.principalCategoryId !== undefined)
      account.principalCategoryId = updateAccountDto.principalCategoryId;
    if (updateAccountDto.interestCategoryId !== undefined)
      account.interestCategoryId = updateAccountDto.interestCategoryId;
    if (updateAccountDto.assetCategoryId !== undefined)
      account.assetCategoryId = updateAccountDto.assetCategoryId;
    if (updateAccountDto.dateAcquired !== undefined)
      account.dateAcquired = updateAccountDto.dateAcquired
        ? new Date(updateAccountDto.dateAcquired)
        : null;
    // Mortgage-specific fields
    if (updateAccountDto.isCanadianMortgage !== undefined)
      account.isCanadianMortgage = updateAccountDto.isCanadianMortgage;
    if (updateAccountDto.isVariableRate !== undefined)
      account.isVariableRate = updateAccountDto.isVariableRate;
    if (updateAccountDto.termMonths !== undefined) {
      account.termMonths = updateAccountDto.termMonths || null;
      // Recalculate termEndDate when termMonths changes
      if (updateAccountDto.termMonths > 0 && account.paymentStartDate) {
        const termEndDate = new Date(account.paymentStartDate);
        termEndDate.setMonth(
          termEndDate.getMonth() + updateAccountDto.termMonths,
        );
        account.termEndDate = termEndDate;
      } else {
        account.termEndDate = null;
      }
    }
    if (updateAccountDto.amortizationMonths !== undefined)
      account.amortizationMonths = updateAccountDto.amortizationMonths;

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
      this.netWorthService
        .recalculateAccount(userId, id)
        .catch((err) =>
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
      throw new BadRequestException("Account is already closed");
    }

    // Check if balance is not zero
    if (Number(account.currentBalance) !== 0) {
      throw new BadRequestException(
        "Cannot close account with non-zero balance. Current balance: " +
          account.currentBalance,
      );
    }

    account.isClosed = true;
    account.closedDate = new Date();

    const saved = await this.accountsRepository.save(account);

    // If this is an investment cash account, also close the linked brokerage account
    if (
      account.accountSubType === AccountSubType.INVESTMENT_CASH &&
      account.linkedAccountId
    ) {
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
      throw new BadRequestException("Account is not closed");
    }

    account.isClosed = false;
    account.closedDate = null;

    const saved = await this.accountsRepository.save(account);

    // If this is an investment cash account, also reopen the linked brokerage account
    if (
      account.accountSubType === AccountSubType.INVESTMENT_CASH &&
      account.linkedAccountId
    ) {
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
  async updateBalance(accountId: string, amount: number): Promise<Account> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException(`Account with ID ${accountId} not found`);
    }

    if (account.isClosed) {
      throw new BadRequestException(
        "Cannot modify balance of a closed account",
      );
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

    const assetTypes = ["CHEQUING", "SAVINGS", "INVESTMENT", "CASH", "ASSET"];
    const liabilityTypes = [
      "CREDIT_CARD",
      "LOAN",
      "MORTGAGE",
      "LINE_OF_CREDIT",
    ];

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
  ): Promise<{
    transactionCount: number;
    investmentTransactionCount: number;
    canDelete: boolean;
  }> {
    // Verify account belongs to user
    await this.findOne(userId, accountId);

    const transactionCount = await this.transactionRepository.count({
      where: { accountId },
    });

    const investmentTransactionCount =
      await this.investmentTransactionRepository.count({
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
    const investmentTransactionCount =
      await this.investmentTransactionRepository.count({
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
      (account.accountType === AccountType.LOAN ||
        account.accountType === AccountType.MORTGAGE) &&
      account.scheduledTransactionId
    ) {
      try {
        await this.scheduledTransactionsService.remove(
          userId,
          account.scheduledTransactionId,
        );
      } catch (error) {
        // Scheduled transaction may have already been deleted, continue with account deletion
        this.logger.warn(
          `Could not delete scheduled transaction ${account.scheduledTransactionId}: ${error.message}`,
        );
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
