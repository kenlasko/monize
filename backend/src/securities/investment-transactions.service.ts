import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InvestmentTransaction, InvestmentAction } from './entities/investment-transaction.entity';
import { CreateInvestmentTransactionDto } from './dto/create-investment-transaction.dto';
import { UpdateInvestmentTransactionDto } from './dto/update-investment-transaction.dto';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { HoldingsService } from './holdings.service';
import { SecuritiesService } from './securities.service';

@Injectable()
export class InvestmentTransactionsService {
  constructor(
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
    private holdingsService: HoldingsService,
    private securitiesService: SecuritiesService,
  ) {}

  async create(
    userId: string,
    createDto: CreateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    // Verify account ownership and that it's an investment account
    const account = await this.accountsService.findOne(userId, createDto.accountId);

    if (account.accountType !== 'INVESTMENT') {
      throw new BadRequestException('Account must be of type INVESTMENT');
    }

    // Validate that security is provided for buy/sell transactions
    if (
      [InvestmentAction.BUY, InvestmentAction.SELL, InvestmentAction.SPLIT, InvestmentAction.REINVEST].includes(
        createDto.action,
      ) &&
      !createDto.securityId
    ) {
      throw new BadRequestException(`Security ID is required for ${createDto.action} transactions`);
    }

    // Verify security exists if provided
    if (createDto.securityId) {
      await this.securitiesService.findOne(createDto.securityId);
    }

    // Calculate total amount based on action type
    const totalAmount = this.calculateTotalAmount(createDto);

    // Create the investment transaction
    const investmentTransaction = this.investmentTransactionsRepository.create({
      userId,
      accountId: createDto.accountId,
      securityId: createDto.securityId,
      action: createDto.action,
      transactionDate: createDto.transactionDate,
      quantity: createDto.quantity,
      price: createDto.price,
      commission: createDto.commission || 0,
      totalAmount,
      description: createDto.description,
    });

    const saved = await this.investmentTransactionsRepository.save(investmentTransaction);

    // Process the transaction effects
    await this.processTransactionEffects(userId, saved);

    return this.findOne(userId, saved.id);
  }

  private calculateTotalAmount(dto: CreateInvestmentTransactionDto): number {
    const { action, quantity, price, commission } = dto;

    switch (action) {
      case InvestmentAction.BUY:
        // Total = (quantity * price) + commission
        return (quantity || 0) * (price || 0) + (commission || 0);

      case InvestmentAction.SELL:
        // Total = (quantity * price) - commission
        return (quantity || 0) * (price || 0) - (commission || 0);

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        // Total = amount received (no quantity/price needed)
        // These should be passed in as a single amount
        return (quantity || 0) * (price || 1); // Use price as amount if quantity is 1

      default:
        return 0;
    }
  }

  private async processTransactionEffects(
    userId: string,
    transaction: InvestmentTransaction,
  ): Promise<void> {
    const { action, accountId, securityId, quantity, price, totalAmount } = transaction;

    switch (action) {
      case InvestmentAction.BUY:
        // Add shares to holdings
        await this.holdingsService.updateHolding(
          userId,
          accountId,
          securityId!,
          Number(quantity),
          Number(price),
        );

        // Decrease cash balance (negative transaction)
        await this.accountsService.updateBalance(accountId, -Number(totalAmount));
        break;

      case InvestmentAction.SELL:
        // Remove shares from holdings
        await this.holdingsService.updateHolding(
          userId,
          accountId,
          securityId!,
          -Number(quantity),
          Number(price),
        );

        // Increase cash balance (positive transaction)
        await this.accountsService.updateBalance(accountId, Number(totalAmount));
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        // Increase cash balance only (no holdings change)
        await this.accountsService.updateBalance(accountId, Number(totalAmount));
        break;

      case InvestmentAction.REINVEST:
        // Use dividends to buy more shares (no cash change)
        if (securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
          );
        }
        break;

      case InvestmentAction.SPLIT:
        // Handle stock split - this would need special logic
        // For now, just log it
        break;

      case InvestmentAction.TRANSFER_IN:
        // Add shares without affecting cash
        if (securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
          );
        }
        break;

      case InvestmentAction.TRANSFER_OUT:
        // Remove shares without affecting cash
        if (securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
          );
        }
        break;
    }
  }

  async findAll(
    userId: string,
    accountId?: string,
    startDate?: string,
    endDate?: string,
    page?: number,
    limit?: number,
  ): Promise<{
    data: InvestmentTransaction[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasMore: boolean;
    };
  }> {
    const pageNum = page && page > 0 ? page : 1;
    const pageSize = limit && limit > 0 ? Math.min(limit, 200) : 50;

    const query = this.investmentTransactionsRepository
      .createQueryBuilder('it')
      .leftJoinAndSelect('it.account', 'account')
      .leftJoinAndSelect('it.security', 'security')
      .where('it.userId = :userId', { userId });

    if (accountId) {
      // Resolve linked account if needed (cash account selected but transactions on brokerage)
      try {
        const account = await this.accountsService.findOne(userId, accountId);
        const accountIds = [accountId];
        if (account.linkedAccountId) {
          accountIds.push(account.linkedAccountId);
        }
        query.andWhere('it.accountId IN (:...accountIds)', { accountIds });
      } catch {
        // If account not found, just filter by the provided ID
        query.andWhere('it.accountId = :accountId', { accountId });
      }
    }

    if (startDate) {
      query.andWhere('it.transactionDate >= :startDate', { startDate });
    }

    if (endDate) {
      query.andWhere('it.transactionDate <= :endDate', { endDate });
    }

    // Get total count for pagination
    const total = await query.getCount();

    // Apply pagination
    const data = await query
      .orderBy('it.transactionDate', 'DESC')
      .skip((pageNum - 1) * pageSize)
      .take(pageSize)
      .getMany();

    const totalPages = Math.ceil(total / pageSize);

    return {
      data,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages,
        hasMore: pageNum < totalPages,
      },
    };
  }

  async findOne(userId: string, id: string): Promise<InvestmentTransaction> {
    const transaction = await this.investmentTransactionsRepository
      .createQueryBuilder('it')
      .leftJoinAndSelect('it.account', 'account')
      .leftJoinAndSelect('it.security', 'security')
      .where('it.id = :id', { id })
      .andWhere('it.userId = :userId', { userId })
      .getOne();

    if (!transaction) {
      throw new NotFoundException(`Investment transaction with ID ${id} not found`);
    }

    return transaction;
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    const transaction = await this.findOne(userId, id);

    // Reverse the original transaction effects
    await this.reverseTransactionEffects(userId, transaction);

    // Update the transaction
    Object.assign(transaction, updateDto);

    if (updateDto.quantity !== undefined || updateDto.price !== undefined || updateDto.commission !== undefined) {
      transaction.totalAmount = this.calculateTotalAmount({
        action: transaction.action,
        quantity: transaction.quantity,
        price: transaction.price,
        commission: transaction.commission,
      } as any);
    }

    const saved = await this.investmentTransactionsRepository.save(transaction);

    // Apply the new transaction effects
    await this.processTransactionEffects(userId, saved);

    return this.findOne(userId, saved.id);
  }

  private async reverseTransactionEffects(
    userId: string,
    transaction: InvestmentTransaction,
  ): Promise<void> {
    const { action, accountId, securityId, quantity, price, totalAmount } = transaction;

    switch (action) {
      case InvestmentAction.BUY:
        // Reverse: remove shares, add cash back
        if (securityId) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
          );
        }
        await this.accountsService.updateBalance(accountId, Number(totalAmount));
        break;

      case InvestmentAction.SELL:
        // Reverse: add shares back, remove cash
        if (securityId) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
          );
        }
        await this.accountsService.updateBalance(accountId, -Number(totalAmount));
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        // Reverse: remove cash
        await this.accountsService.updateBalance(accountId, -Number(totalAmount));
        break;

      case InvestmentAction.REINVEST:
        // Reverse: remove shares
        if (securityId && quantity) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
          );
        }
        break;

      case InvestmentAction.TRANSFER_IN:
        // Reverse: remove shares
        if (securityId && quantity) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
          );
        }
        break;

      case InvestmentAction.TRANSFER_OUT:
        // Reverse: add shares back
        if (securityId && quantity) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
          );
        }
        break;
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);

    // Reverse the transaction effects
    await this.reverseTransactionEffects(userId, transaction);

    // Delete the transaction
    await this.investmentTransactionsRepository.remove(transaction);
  }

  async getSummary(userId: string, accountId?: string) {
    // Get all transactions (no pagination for summary)
    const result = await this.findAll(userId, accountId, undefined, undefined, 1, 10000);
    const transactions = result.data;

    const summary = {
      totalTransactions: transactions.length,
      totalBuys: transactions.filter((t) => t.action === InvestmentAction.BUY).length,
      totalSells: transactions.filter((t) => t.action === InvestmentAction.SELL).length,
      totalDividends: transactions
        .filter((t) => t.action === InvestmentAction.DIVIDEND)
        .reduce((sum, t) => sum + Number(t.totalAmount), 0),
      totalInterest: transactions
        .filter((t) => t.action === InvestmentAction.INTEREST)
        .reduce((sum, t) => sum + Number(t.totalAmount), 0),
      totalCapitalGains: transactions
        .filter((t) => t.action === InvestmentAction.CAPITAL_GAIN)
        .reduce((sum, t) => sum + Number(t.totalAmount), 0),
      totalCommissions: transactions.reduce((sum, t) => sum + Number(t.commission || 0), 0),
    };

    return summary;
  }

  /**
   * Delete all investment transactions and holdings for a user.
   * Also resets brokerage account balances to 0.
   * USE WITH CAUTION - this is destructive!
   */
  async removeAll(userId: string): Promise<{
    transactionsDeleted: number;
    holdingsDeleted: number;
    accountsReset: number;
  }> {
    // Get all investment transactions for the user
    const transactions = await this.investmentTransactionsRepository.find({
      where: { userId },
    });
    const transactionsDeleted = transactions.length;

    // Delete all transactions (without reversing effects since we'll reset balances)
    if (transactions.length > 0) {
      await this.investmentTransactionsRepository.remove(transactions);
    }

    // Delete all holdings via the holdings service
    const holdingsResult = await this.holdingsService.removeAllForUser(userId);

    // Reset brokerage account balances to 0
    const accountsReset = await this.accountsService.resetBrokerageBalances(userId);

    return {
      transactionsDeleted,
      holdingsDeleted: holdingsResult,
      accountsReset,
    };
  }
}
