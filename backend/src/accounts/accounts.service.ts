import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from './entities/account.entity';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
  ) {}

  /**
   * Create a new account for a user
   */
  async create(userId: string, createAccountDto: CreateAccountDto): Promise<Account> {
    const { openingBalance = 0, ...accountData } = createAccountDto;

    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance,
      currentBalance: openingBalance,
    });

    return this.accountsRepository.save(account);
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

    account.currentBalance = Number(account.currentBalance) + Number(amount);
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
}
