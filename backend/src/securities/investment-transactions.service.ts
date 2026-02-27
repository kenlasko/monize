import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner } from "typeorm";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { CreateInvestmentTransactionDto } from "./dto/create-investment-transaction.dto";
import { UpdateInvestmentTransactionDto } from "./dto/update-investment-transaction.dto";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { HoldingsService } from "./holdings.service";
import { SecuritiesService } from "./securities.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";

@Injectable()
export class InvestmentTransactionsService {
  private readonly logger = new Logger(InvestmentTransactionsService.name);

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
    private netWorthService: NetWorthService,
  ) {}

  private async findCashAccount(
    userId: string,
    accountId: string,
  ): Promise<Account> {
    const account = await this.accountsService.findOne(userId, accountId);

    if (
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
      account.linkedAccountId
    ) {
      return this.accountsService.findOne(userId, account.linkedAccountId);
    }

    return account;
  }

  private formatCashTransactionPayeeName(
    action: InvestmentAction,
    symbol: string | null,
    quantity: number | null,
    price: number | null,
    totalAmount: number,
  ): string {
    const formatPrice = (value: number) => {
      return value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      });
    };

    const formatQuantity = (value: number) => {
      return Number(value.toFixed(4)).toString();
    };

    const formatAction = (act: string) => {
      return act
        .split("_")
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
    };

    const actionLabel = formatAction(action);

    switch (action) {
      case InvestmentAction.BUY:
      case InvestmentAction.SELL:
        return `${actionLabel}: ${symbol || "Unknown"} ${formatQuantity(quantity || 0)} @ ${formatPrice(price || 0)}`;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.CAPITAL_GAIN:
        return `${actionLabel}: ${symbol || "Unknown"} ${formatPrice(totalAmount)}`;

      case InvestmentAction.INTEREST:
        return `${actionLabel}: ${formatPrice(totalAmount)}`;

      default:
        return `${actionLabel}: ${symbol || ""} ${formatPrice(totalAmount)}`;
    }
  }

  private async createCashTransactionInTransaction(
    queryRunner: QueryRunner,
    userId: string,
    cashAccount: Account,
    investmentTransaction: InvestmentTransaction,
    amount: number,
  ): Promise<string> {
    let symbol: string | null = null;
    if (investmentTransaction.securityId) {
      const security = await this.securitiesService.findOne(
        userId,
        investmentTransaction.securityId,
      );
      symbol = security.symbol;
    }

    const payeeName = this.formatCashTransactionPayeeName(
      investmentTransaction.action,
      symbol,
      investmentTransaction.quantity,
      investmentTransaction.price,
      Math.abs(investmentTransaction.totalAmount),
    );

    const cashTransaction = queryRunner.manager.create(Transaction, {
      userId,
      accountId: cashAccount.id,
      transactionDate: investmentTransaction.transactionDate,
      amount,
      currencyCode: cashAccount.currencyCode,
      exchangeRate: 1,
      payeeName,
      payeeId: null,
      description: investmentTransaction.description,
      status: TransactionStatus.CLEARED,
    });

    const saved = await queryRunner.manager.save(cashTransaction);

    await this.accountsService.updateBalance(
      cashAccount.id,
      amount,
      queryRunner,
    );

    return saved.id;
  }

  private async deleteCashTransactionInTransaction(
    queryRunner: QueryRunner,
    userId: string,
    transactionId: string | null,
  ): Promise<void> {
    if (!transactionId) return;

    const cashTransaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: transactionId, userId },
    });

    if (cashTransaction) {
      await this.accountsService.updateBalance(
        cashTransaction.accountId,
        -Number(cashTransaction.amount),
        queryRunner,
      );
      await queryRunner.manager.remove(cashTransaction);
    }
  }

  async create(
    userId: string,
    createDto: CreateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    const account = await this.accountsService.findOne(
      userId,
      createDto.accountId,
    );

    if (account.accountType !== "INVESTMENT") {
      throw new BadRequestException("Account must be of type INVESTMENT");
    }

    if (
      [
        InvestmentAction.BUY,
        InvestmentAction.SELL,
        InvestmentAction.SPLIT,
        InvestmentAction.REINVEST,
        InvestmentAction.ADD_SHARES,
        InvestmentAction.REMOVE_SHARES,
      ].includes(createDto.action) &&
      !createDto.securityId
    ) {
      throw new BadRequestException(
        `Security ID is required for ${createDto.action} transactions`,
      );
    }

    if (createDto.securityId) {
      await this.securitiesService.findOne(userId, createDto.securityId);
    }

    const totalAmount = this.calculateTotalAmount(createDto);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedId: string;

    try {
      const investmentTransaction = queryRunner.manager.create(
        InvestmentTransaction,
        {
          userId,
          accountId: createDto.accountId,
          securityId: createDto.securityId,
          fundingAccountId: createDto.fundingAccountId || null,
          action: createDto.action,
          transactionDate: createDto.transactionDate,
          quantity: createDto.quantity ?? 0,
          price: createDto.price ?? 0,
          commission: createDto.commission || 0,
          totalAmount,
          description: createDto.description,
        },
      );

      const saved = await queryRunner.manager.save(investmentTransaction);
      savedId = saved.id;

      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        saved,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.netWorthService.triggerDebouncedRecalc(createDto.accountId, userId);

    return this.findOne(userId, savedId);
  }

  private calculateTotalAmount(dto: CreateInvestmentTransactionDto): number {
    const { action, quantity, price, commission } = dto;

    switch (action) {
      case InvestmentAction.BUY:
        return (quantity || 0) * (price || 0) + (commission || 0);

      case InvestmentAction.SELL:
        return (quantity || 0) * (price || 0) - (commission || 0);

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        return (quantity || 1) * (price || 0);

      case InvestmentAction.ADD_SHARES:
      case InvestmentAction.REMOVE_SHARES:
        return 0;

      default:
        return 0;
    }
  }

  private async processTransactionEffectsInTransaction(
    queryRunner: QueryRunner,
    userId: string,
    transaction: InvestmentTransaction,
  ): Promise<void> {
    if (isTransactionInFuture(transaction.transactionDate)) {
      return;
    }

    const {
      action,
      accountId,
      securityId,
      quantity,
      price,
      totalAmount,
      fundingAccountId,
    } = transaction;

    let cashAccount: Account;
    if (fundingAccountId) {
      cashAccount = await this.accountsService.findOne(
        userId,
        fundingAccountId,
      );
    } else {
      cashAccount = await this.findCashAccount(userId, accountId);
    }
    let cashTransactionId: string | null = null;

    switch (action) {
      case InvestmentAction.BUY:
        await this.holdingsService.updateHolding(
          userId,
          accountId,
          securityId!,
          Number(quantity),
          Number(price),
          queryRunner,
        );
        cashTransactionId = await this.createCashTransactionInTransaction(
          queryRunner,
          userId,
          cashAccount,
          transaction,
          -Number(totalAmount),
        );
        break;

      case InvestmentAction.SELL:
        await this.holdingsService.updateHolding(
          userId,
          accountId,
          securityId!,
          -Number(quantity),
          Number(price),
          queryRunner,
        );
        cashTransactionId = await this.createCashTransactionInTransaction(
          queryRunner,
          userId,
          cashAccount,
          transaction,
          Number(totalAmount),
        );
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        cashTransactionId = await this.createCashTransactionInTransaction(
          queryRunner,
          userId,
          cashAccount,
          transaction,
          Number(totalAmount),
        );
        break;

      case InvestmentAction.REINVEST:
        if (securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.SPLIT:
        break;

      case InvestmentAction.TRANSFER_IN:
        if (securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.TRANSFER_OUT:
        if (securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.ADD_SHARES:
        if (securityId && quantity) {
          await this.holdingsService.adjustQuantity(
            userId,
            accountId,
            securityId,
            Number(quantity),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.REMOVE_SHARES:
        if (securityId && quantity) {
          await this.holdingsService.adjustQuantity(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            queryRunner,
          );
        }
        break;
    }

    if (cashTransactionId) {
      await queryRunner.manager.update(InvestmentTransaction, transaction.id, {
        transactionId: cashTransactionId,
      });
    }
  }

  async findAll(
    userId: string,
    accountIds?: string[],
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
      .createQueryBuilder("it")
      .leftJoinAndSelect("it.account", "account")
      .leftJoinAndSelect("it.security", "security")
      .leftJoinAndSelect("it.fundingAccount", "fundingAccount")
      .where("it.userId = :userId", { userId });

    if (accountIds && accountIds.length > 0) {
      const resolvedIds = new Set<string>(accountIds);
      for (const id of accountIds) {
        try {
          const acct = await this.accountsService.findOne(userId, id);
          if (acct.linkedAccountId) {
            resolvedIds.add(acct.linkedAccountId);
          }
        } catch {
          // Account not found, keep the original ID
        }
      }
      const allIds = [...resolvedIds];
      query.andWhere("it.accountId IN (:...allIds)", { allIds });
    }

    if (startDate) {
      query.andWhere("it.transactionDate >= :startDate", { startDate });
    }

    if (endDate) {
      query.andWhere("it.transactionDate <= :endDate", { endDate });
    }

    if (symbol) {
      query.andWhere("LOWER(security.symbol) = LOWER(:symbol)", { symbol });
    }

    if (action) {
      query.andWhere("it.action = :action", { action });
    }

    const total = await query.getCount();

    const data = await query
      .orderBy("it.transactionDate", "DESC")
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
      .createQueryBuilder("it")
      .leftJoinAndSelect("it.account", "account")
      .leftJoinAndSelect("it.security", "security")
      .leftJoinAndSelect("it.fundingAccount", "fundingAccount")
      .where("it.id = :id", { id })
      .andWhere("it.userId = :userId", { userId })
      .getOne();

    if (!transaction) {
      throw new NotFoundException(
        `Investment transaction with ID ${id} not found`,
      );
    }

    return transaction;
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    const transaction = await this.findOne(userId, id);
    const accountId = transaction.accountId;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedId: string;

    try {
      // Reverse the original transaction effects
      await this.reverseTransactionEffectsInTransaction(
        queryRunner,
        userId,
        transaction,
      );

      // Update entity properties directly
      if (updateDto.accountId !== undefined)
        transaction.accountId = updateDto.accountId;
      if (updateDto.action !== undefined) transaction.action = updateDto.action;
      if (updateDto.transactionDate !== undefined)
        transaction.transactionDate = updateDto.transactionDate;
      if (updateDto.securityId !== undefined)
        transaction.securityId = updateDto.securityId;
      if (updateDto.fundingAccountId !== undefined)
        transaction.fundingAccountId = updateDto.fundingAccountId || null;
      if (updateDto.quantity !== undefined)
        transaction.quantity = updateDto.quantity;
      if (updateDto.price !== undefined) transaction.price = updateDto.price;
      if (updateDto.commission !== undefined)
        transaction.commission = updateDto.commission;
      if (updateDto.description !== undefined)
        transaction.description = updateDto.description;

      if (
        updateDto.quantity !== undefined ||
        updateDto.price !== undefined ||
        updateDto.commission !== undefined
      ) {
        transaction.totalAmount = this.calculateTotalAmount({
          action: transaction.action,
          quantity: transaction.quantity,
          price: transaction.price,
          commission: transaction.commission,
        } as any);
      }

      const saved = await queryRunner.manager.save(transaction);
      savedId = saved.id;

      // Apply the new transaction effects
      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        saved,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.netWorthService.triggerDebouncedRecalc(
      updateDto.accountId ?? accountId,
      userId,
    );

    return this.findOne(userId, savedId);
  }

  private async reverseTransactionEffectsInTransaction(
    queryRunner: QueryRunner,
    userId: string,
    transaction: InvestmentTransaction,
  ): Promise<void> {
    if (isTransactionInFuture(transaction.transactionDate)) {
      return;
    }

    const { action, accountId, securityId, quantity, price, transactionId } =
      transaction;

    if (transactionId) {
      // Clear the FK reference BEFORE deleting the cash transaction
      await queryRunner.manager.update(InvestmentTransaction, transaction.id, {
        transactionId: null,
      });
      transaction.transactionId = null;
      await this.deleteCashTransactionInTransaction(
        queryRunner,
        userId,
        transactionId,
      );
    }

    switch (action) {
      case InvestmentAction.BUY:
        if (securityId) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.SELL:
        if (securityId) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        break;

      case InvestmentAction.REINVEST:
        if (securityId && quantity) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.TRANSFER_IN:
        if (securityId && quantity) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.TRANSFER_OUT:
        if (securityId && quantity) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.ADD_SHARES:
        if (securityId && quantity) {
          await this.holdingsService.adjustQuantity(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.REMOVE_SHARES:
        if (securityId && quantity) {
          await this.holdingsService.adjustQuantity(
            userId,
            accountId,
            securityId,
            Number(quantity),
            queryRunner,
          );
        }
        break;
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);
    const { accountId } = transaction;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.reverseTransactionEffectsInTransaction(
        queryRunner,
        userId,
        transaction,
      );

      await queryRunner.manager.remove(transaction);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.netWorthService.triggerDebouncedRecalc(accountId, userId);
  }

  async getSummary(userId: string, accountIds?: string[]) {
    const result = await this.findAll(
      userId,
      accountIds,
      undefined,
      undefined,
      1,
      10000,
    );
    const transactions = result.data;

    const summary = {
      totalTransactions: transactions.length,
      totalBuys: transactions.filter((t) => t.action === InvestmentAction.BUY)
        .length,
      totalSells: transactions.filter((t) => t.action === InvestmentAction.SELL)
        .length,
      totalDividends: transactions
        .filter((t) => t.action === InvestmentAction.DIVIDEND)
        .reduce((sum, t) => sum + Number(t.totalAmount), 0),
      totalInterest: transactions
        .filter((t) => t.action === InvestmentAction.INTEREST)
        .reduce((sum, t) => sum + Number(t.totalAmount), 0),
      totalCapitalGains: transactions
        .filter((t) => t.action === InvestmentAction.CAPITAL_GAIN)
        .reduce((sum, t) => sum + Number(t.totalAmount), 0),
      totalCommissions: transactions.reduce(
        (sum, t) => sum + Number(t.commission || 0),
        0,
      ),
    };

    return summary;
  }

  async removeAll(userId: string): Promise<{
    transactionsDeleted: number;
    holdingsDeleted: number;
    accountsReset: number;
  }> {
    const transactions = await this.investmentTransactionsRepository.find({
      where: { userId },
    });
    const transactionsDeleted = transactions.length;

    if (transactions.length > 0) {
      await this.investmentTransactionsRepository.remove(transactions);
    }

    const holdingsResult = await this.holdingsService.removeAllForUser(userId);

    const accountsReset =
      await this.accountsService.resetBrokerageBalances(userId);

    return {
      transactionsDeleted,
      holdingsDeleted: holdingsResult,
      accountsReset,
    };
  }
}
