import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { InvestmentTransaction, InvestmentAction } from './entities/investment-transaction.entity';
import { CreateInvestmentTransactionDto } from './dto/create-investment-transaction.dto';
import { UpdateInvestmentTransactionDto } from './dto/update-investment-transaction.dto';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { HoldingsService } from './holdings.service';
import { SecuritiesService } from './securities.service';
import { Transaction, TransactionStatus } from '../transactions/entities/transaction.entity';
import { Account, AccountSubType } from '../accounts/entities/account.entity';

@Injectable()
export class InvestmentTransactionsService {
  constructor(
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private dataSource: DataSource,
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
    private holdingsService: HoldingsService,
    private securitiesService: SecuritiesService,
  ) {}

  /**
   * Find the appropriate cash account for an investment transaction.
   * For paired accounts (cash + brokerage), returns the linked cash account.
   * For standalone accounts, returns the same account.
   */
  private async findCashAccount(userId: string, accountId: string): Promise<Account> {
    const account = await this.accountsService.findOne(userId, accountId);

    // If this is a brokerage account with a linked cash account, return the cash account
    if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE && account.linkedAccountId) {
      return this.accountsService.findOne(userId, account.linkedAccountId);
    }

    // For standalone accounts or cash accounts, return the same account
    return account;
  }

  /**
   * Format the payee name for a cash transaction created from an investment transaction.
   * Format: "Action: SYMBOL Vol @ $Price" for buy/sell, "Action: SYMBOL $Amount" for dividends, etc.
   */
  private formatCashTransactionPayeeName(
    action: InvestmentAction,
    symbol: string | null,
    quantity: number | null,
    price: number | null,
    totalAmount: number,
  ): string {
    const formatPrice = (value: number) => {
      return value.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      });
    };

    const formatQuantity = (value: number) => {
      // Show up to 4 decimal places, but trim trailing zeros
      return Number(value.toFixed(4)).toString();
    };

    // Convert action to title case (e.g., "BUY" -> "Buy", "CAPITAL_GAIN" -> "Capital Gain")
    const formatAction = (act: string) => {
      return act
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    };

    const actionLabel = formatAction(action);

    switch (action) {
      case InvestmentAction.BUY:
      case InvestmentAction.SELL:
        return `${actionLabel}: ${symbol || 'Unknown'} ${formatQuantity(quantity || 0)} @ ${formatPrice(price || 0)}`;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.CAPITAL_GAIN:
        return `${actionLabel}: ${symbol || 'Unknown'} ${formatPrice(totalAmount)}`;

      case InvestmentAction.INTEREST:
        return `${actionLabel}: ${formatPrice(totalAmount)}`;

      default:
        return `${actionLabel}: ${symbol || ''} ${formatPrice(totalAmount)}`;
    }
  }

  /**
   * Create a cash transaction in the cash account to record the cash effect of an investment transaction.
   * Returns the created transaction ID.
   */
  private async createCashTransaction(
    userId: string,
    cashAccount: Account,
    investmentTransaction: InvestmentTransaction,
    amount: number, // Positive for inflows (sell, dividend), negative for outflows (buy)
  ): Promise<string> {
    // Get the security for the symbol
    let symbol: string | null = null;
    if (investmentTransaction.securityId) {
      const security = await this.securitiesService.findOne(investmentTransaction.securityId);
      symbol = security.symbol;
    }

    const payeeName = this.formatCashTransactionPayeeName(
      investmentTransaction.action,
      symbol,
      investmentTransaction.quantity,
      investmentTransaction.price,
      Math.abs(investmentTransaction.totalAmount),
    );

    const cashTransaction = this.transactionRepository.create({
      userId,
      accountId: cashAccount.id,
      transactionDate: investmentTransaction.transactionDate,
      amount,
      currencyCode: cashAccount.currencyCode,
      exchangeRate: 1,
      payeeName, // Display-only payee, not linked to a Payee entity
      payeeId: null,
      description: investmentTransaction.description,
      status: TransactionStatus.CLEARED,
    });

    const saved = await this.transactionRepository.save(cashTransaction);

    // Update the cash account balance
    await this.accountsService.updateBalance(cashAccount.id, amount);

    return saved.id;
  }

  /**
   * Delete the cash transaction associated with an investment transaction
   */
  private async deleteCashTransaction(
    userId: string,
    transactionId: string | null,
  ): Promise<void> {
    if (!transactionId) return;

    const cashTransaction = await this.transactionRepository.findOne({
      where: { id: transactionId, userId },
    });

    if (cashTransaction) {
      // Reverse the balance change
      await this.accountsService.updateBalance(
        cashTransaction.accountId,
        -Number(cashTransaction.amount),
      );
      await this.transactionRepository.remove(cashTransaction);
    }
  }

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

    // Find the appropriate cash account for cash-affecting transactions
    const cashAccount = await this.findCashAccount(userId, accountId);
    let cashTransactionId: string | null = null;

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

        // Create cash transaction (negative amount for outflow)
        cashTransactionId = await this.createCashTransaction(
          userId,
          cashAccount,
          transaction,
          -Number(totalAmount),
        );
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

        // Create cash transaction (positive amount for inflow)
        cashTransactionId = await this.createCashTransaction(
          userId,
          cashAccount,
          transaction,
          Number(totalAmount),
        );
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        // Create cash transaction (positive amount for inflow)
        cashTransactionId = await this.createCashTransaction(
          userId,
          cashAccount,
          transaction,
          Number(totalAmount),
        );
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

    // Update the investment transaction with the cash transaction ID if one was created
    if (cashTransactionId) {
      await this.investmentTransactionsRepository.update(transaction.id, {
        transactionId: cashTransactionId,
      });
    }
  }

  async findAll(
    userId: string,
    accountId?: string,
    startDate?: string,
    endDate?: string,
    page?: number,
    limit?: number,
    symbol?: string,
    action?: string,
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

    if (symbol) {
      query.andWhere('LOWER(security.symbol) = LOWER(:symbol)', { symbol });
    }

    if (action) {
      query.andWhere('it.action = :action', { action });
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
    const { action, accountId, securityId, quantity, price, transactionId } = transaction;

    // Delete the linked cash transaction if it exists (this also reverses the balance)
    if (transactionId) {
      await this.deleteCashTransaction(userId, transactionId);
      // Clear the reference to avoid foreign key constraint violation when saving
      transaction.transactionId = null;
    }

    switch (action) {
      case InvestmentAction.BUY:
        // Reverse: remove shares
        if (securityId) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
          );
        }
        break;

      case InvestmentAction.SELL:
        // Reverse: add shares back
        if (securityId) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
          );
        }
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        // Cash transaction deletion already handled above
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
