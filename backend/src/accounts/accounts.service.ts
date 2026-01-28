import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account, AccountType, AccountSubType } from './entities/account.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { InvestmentTransaction } from '../securities/entities/investment-transaction.entity';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionRepository: Repository<InvestmentTransaction>,
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
  async findAll(userId: string, includeInactive = false): Promise<Account[]> {
    const queryBuilder = this.accountsRepository
      .createQueryBuilder('account')
      .where('account.userId = :userId', { userId })
      .orderBy('account.createdAt', 'DESC');

    if (!includeInactive) {
      queryBuilder.andWhere('account.isClosed = :isClosed', { isClosed: false });
    }

    return queryBuilder.getMany();
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

    Object.assign(account, updateAccountDto);
    return this.accountsRepository.save(account);
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

    return this.accountsRepository.save(account);
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

    return this.accountsRepository.save(account);
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

    const assetTypes = ['CHEQUING', 'SAVINGS', 'RRSP', 'TFSA', 'RESP', 'INVESTMENT', 'CASH'];
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
