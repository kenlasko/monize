import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner, In } from "typeorm";
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
import { SecurityPriceService } from "./security-price.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { CurrenciesService } from "../currencies/currencies.service";
import { roundToDecimals } from "../common/round.util";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { ActionHistoryService } from "../action-history/action-history.service";

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
    private securityPriceService: SecurityPriceService,
    private netWorthService: NetWorthService,
    private actionHistoryService: ActionHistoryService,
    private exchangeRateService: ExchangeRateService,
    private currenciesService: CurrenciesService,
  ) {}

  private static readonly PRICE_ACTIONS: ReadonlySet<InvestmentAction> =
    new Set([
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.REINVEST,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.TRANSFER_OUT,
    ]);

  /**
   * Trigger net worth recalc for the given account and its linked cash account.
   * Investment transactions affect both the brokerage (holdings) and the linked
   * cash account (cash balance), so both need their snapshots updated.
   */
  private triggerRecalcWithCashAccount(
    accountId: string,
    userId: string,
    fundingAccountId?: string | null,
  ): void {
    this.netWorthService.triggerDebouncedRecalc(accountId, userId);

    if (fundingAccountId) {
      this.netWorthService.triggerDebouncedRecalc(fundingAccountId, userId);
    } else {
      this.accountsService
        .findOne(userId, accountId)
        .then((account) => {
          if (
            account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
            account.linkedAccountId
          ) {
            this.netWorthService.triggerDebouncedRecalc(
              account.linkedAccountId,
              userId,
            );
          }
        })
        .catch((err) =>
          this.logger.warn(
            `Failed to trigger cash account recalc for ${accountId}: ${err.message}`,
          ),
        );
    }
  }

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

  /**
   * Resolve the exchange rate used to convert a transaction's total amount
   * (expressed in the security's currency) into the cash account's currency.
   *
   * Precedence:
   *  1. Explicit DTO override (the user entered a rate in the form).
   *  2. Latest market rate between source and target currencies.
   *  3. Fallback of 1 when no rate is available.
   */
  private async resolveCashExchangeRate(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
    securityId: string | null | undefined,
    dtoRate: number | undefined,
  ): Promise<number> {
    if (dtoRate !== undefined && dtoRate !== null) {
      return Number(dtoRate);
    }

    const cashAccount = fundingAccountId
      ? await this.accountsService.findOne(userId, fundingAccountId)
      : await this.findCashAccount(userId, accountId);

    let sourceCurrency: string;
    if (securityId) {
      const security = await this.securitiesService.findOne(userId, securityId);
      sourceCurrency = security.currencyCode;
    } else {
      const investmentAccount = await this.accountsService.findOne(
        userId,
        accountId,
      );
      sourceCurrency = investmentAccount.currencyCode;
    }

    if (sourceCurrency === cashAccount.currencyCode) {
      return 1;
    }

    const rate = await this.exchangeRateService.getLatestRate(
      sourceCurrency,
      cashAccount.currencyCode,
    );

    if (rate === null) {
      this.logger.warn(
        `No exchange rate found for ${sourceCurrency}->${cashAccount.currencyCode}, falling back to 1`,
      );
      return 1;
    }

    return rate;
  }

  private formatCashTransactionPayeeName(
    action: InvestmentAction,
    symbol: string | null,
    quantity: number | null,
    price: number | null,
    totalAmount: number,
    currencyCode: string = "USD",
  ): string {
    const formatPrice = (value: number) => {
      return value.toLocaleString("en-US", {
        style: "currency",
        currency: currencyCode,
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
    sourceAmount: number,
  ): Promise<string> {
    let symbol: string | null = null;
    let sourceCurrency = cashAccount.currencyCode;
    if (investmentTransaction.securityId) {
      const security = await this.securitiesService.findOne(
        userId,
        investmentTransaction.securityId,
      );
      symbol = security.symbol;
      sourceCurrency = security.currencyCode;
    }

    // Payee name is rendered in the security's currency because the values
    // being displayed (price per share, totalAmount) are denominated there.
    const payeeName = this.formatCashTransactionPayeeName(
      investmentTransaction.action,
      symbol,
      investmentTransaction.quantity,
      investmentTransaction.price,
      Math.abs(investmentTransaction.totalAmount),
      sourceCurrency,
    );

    const exchangeRate = Number(investmentTransaction.exchangeRate) || 1;
    // Convert the signed source amount (security currency) into the cash
    // account's currency so balance updates reflect the correct amount.
    // Round to the cash account's currency precision (typically 2 decimals)
    // rather than 4, so sub-cent residue from quantity * price (e.g. 0.1985 *
    // 50.01 = 9.9270) doesn't accumulate as visible drift in the displayed
    // cash balance. Cash in the real world only moves in whole cents.
    const cashCurrency = await this.currenciesService.findOne(
      cashAccount.currencyCode,
    );
    const cashAmount = roundToDecimals(
      sourceAmount * exchangeRate,
      cashCurrency.decimalPlaces,
    );

    const cashTransaction = queryRunner.manager.create(Transaction, {
      userId,
      accountId: cashAccount.id,
      transactionDate: investmentTransaction.transactionDate,
      amount: cashAmount,
      currencyCode: cashAccount.currencyCode,
      exchangeRate,
      payeeName,
      payeeId: null,
      description: investmentTransaction.description,
      status: TransactionStatus.CLEARED,
    });

    const saved = await queryRunner.manager.save(cashTransaction);

    await this.accountsService.updateBalance(
      cashAccount.id,
      cashAmount,
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

    // Resolve the rate that will convert totalAmount (security currency)
    // into the cash account's currency when we post the linked cash transaction.
    const exchangeRate = await this.resolveCashExchangeRate(
      userId,
      createDto.accountId,
      createDto.fundingAccountId ?? null,
      createDto.securityId ?? null,
      createDto.exchangeRate,
    );

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
          exchangeRate,
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

    this.triggerRecalcWithCashAccount(
      createDto.accountId,
      userId,
      createDto.fundingAccountId,
    );

    if (
      createDto.securityId &&
      InvestmentTransactionsService.PRICE_ACTIONS.has(createDto.action)
    ) {
      this.securityPriceService
        .upsertTransactionPrice(createDto.securityId, createDto.transactionDate)
        .catch((err) =>
          this.logger.warn(
            `Failed to update transaction-derived price: ${err.message}`,
          ),
        );
    }

    const result = await this.findOne(userId, savedId);

    // Capture linked cash transaction for redo support
    const afterData: Record<string, unknown> = { ...result };
    if (result.transactionId) {
      const cashTx = await this.transactionRepository.findOne({
        where: { id: result.transactionId, userId },
      });
      if (cashTx) {
        afterData.linkedCashTransaction = { ...cashTx };
      }
    }

    this.actionHistoryService.record(userId, {
      entityType: "investment_transaction",
      entityId: result.id,
      action: "create",
      afterData,
      description: `Created ${createDto.action} transaction${createDto.securityId ? "" : ""}`,
    });

    return result;
  }

  private calculateTotalAmount(dto: CreateInvestmentTransactionDto): number {
    const { action, quantity, price, commission } = dto;

    let result: number;
    switch (action) {
      case InvestmentAction.BUY:
        result = (quantity || 0) * (price || 0) + (commission || 0);
        break;

      case InvestmentAction.SELL:
        result = (quantity || 0) * (price || 0) - (commission || 0);
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        result = (quantity || 1) * (price || 0);
        break;

      case InvestmentAction.ADD_SHARES:
      case InvestmentAction.REMOVE_SHARES:
        return 0;

      default:
        return 0;
    }

    // M13: Round to 4 decimal places to avoid floating-point drift
    return roundToDecimals(result, 4);
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
        // H13: Apply stock split ratio to adjust holdings quantity
        if (securityId && quantity) {
          const splitRatio = Number(quantity);
          const holding = await this.holdingsService.findByAccountAndSecurity(
            accountId,
            securityId,
            queryRunner,
          );
          if (holding) {
            const currentQty = Number(holding.quantity);
            const newQty = currentQty * splitRatio;
            const additionalShares = newQty - currentQty;
            if (Math.abs(additionalShares) > 0.00000001) {
              await this.holdingsService.adjustQuantity(
                userId,
                accountId,
                securityId,
                additionalShares,
                queryRunner,
              );
            }
          }
        }
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
      // Batch-fetch accounts to resolve linked account IDs
      const accounts = await this.accountsService.findByIds(userId, accountIds);
      for (const acct of accounts) {
        if (acct.linkedAccountId) {
          resolvedIds.add(acct.linkedAccountId);
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
    const beforeData = { ...transaction };
    const accountId = transaction.accountId;
    const oldSecurityId = transaction.securityId;
    const oldTransactionDate = transaction.transactionDate;
    const oldAction = transaction.action;

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
      if (updateDto.action !== undefined) {
        // M18: Re-validate security requirement when action changes
        const securityRequiredActions = [
          InvestmentAction.BUY,
          InvestmentAction.SELL,
          InvestmentAction.SPLIT,
          InvestmentAction.REINVEST,
          InvestmentAction.ADD_SHARES,
          InvestmentAction.REMOVE_SHARES,
        ];
        const effectiveSecurityId =
          updateDto.securityId !== undefined
            ? updateDto.securityId
            : transaction.securityId;
        if (
          securityRequiredActions.includes(updateDto.action) &&
          !effectiveSecurityId
        ) {
          throw new BadRequestException(
            `Security ID is required for ${updateDto.action} transactions`,
          );
        }
        transaction.action = updateDto.action;
      }
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

      // Exchange rate resolution precedence for update():
      //   1. DTO override wins.
      //   2. If the account, funding account, or security changed, re-resolve
      //      against the latest market rate so the rate matches the new
      //      currency pair.
      //   3. Otherwise keep the rate that was already stored.
      if (updateDto.exchangeRate !== undefined) {
        transaction.exchangeRate = updateDto.exchangeRate;
      } else {
        const accountChanged =
          updateDto.accountId !== undefined &&
          updateDto.accountId !== accountId;
        const fundingChanged =
          updateDto.fundingAccountId !== undefined &&
          (updateDto.fundingAccountId || null) !== transaction.fundingAccountId;
        const securityChanged =
          updateDto.securityId !== undefined &&
          updateDto.securityId !== oldSecurityId;

        if (accountChanged || fundingChanged || securityChanged) {
          transaction.exchangeRate = await this.resolveCashExchangeRate(
            userId,
            transaction.accountId,
            transaction.fundingAccountId,
            transaction.securityId,
            undefined,
          );
        }
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

    this.triggerRecalcWithCashAccount(updateDto.accountId ?? accountId, userId);

    // Update transaction-derived prices for the new security/date
    const newSecurityId = transaction.securityId;
    const newTransactionDate = transaction.transactionDate;
    const newAction = transaction.action;
    if (
      newSecurityId &&
      InvestmentTransactionsService.PRICE_ACTIONS.has(newAction)
    ) {
      this.securityPriceService
        .upsertTransactionPrice(newSecurityId, newTransactionDate)
        .catch((err) =>
          this.logger.warn(
            `Failed to update transaction-derived price: ${err.message}`,
          ),
        );
    }

    // Clean up old security/date if it changed
    if (
      oldSecurityId &&
      InvestmentTransactionsService.PRICE_ACTIONS.has(oldAction) &&
      (oldSecurityId !== newSecurityId ||
        oldTransactionDate !== newTransactionDate)
    ) {
      this.securityPriceService
        .upsertTransactionPrice(oldSecurityId, oldTransactionDate)
        .catch((err) =>
          this.logger.warn(
            `Failed to clean up old transaction-derived price: ${err.message}`,
          ),
        );
    }

    const result = await this.findOne(userId, savedId);

    this.actionHistoryService.record(userId, {
      entityType: "investment_transaction",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...result },
      description: `Updated ${result.action} transaction`,
    });

    return result;
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
    const beforeData: Record<string, unknown> = { ...transaction };
    const { accountId } = transaction;

    // Capture linked cash transaction for undo support
    if (transaction.transactionId) {
      const cashTx = await this.transactionRepository.findOne({
        where: { id: transaction.transactionId, userId },
      });
      if (cashTx) {
        beforeData.linkedCashTransaction = { ...cashTx };
      }
    }

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

    this.triggerRecalcWithCashAccount(
      accountId,
      userId,
      transaction.fundingAccountId,
    );

    if (
      transaction.securityId &&
      InvestmentTransactionsService.PRICE_ACTIONS.has(transaction.action)
    ) {
      this.securityPriceService
        .upsertTransactionPrice(
          transaction.securityId,
          transaction.transactionDate,
        )
        .catch((err) =>
          this.logger.warn(
            `Failed to update transaction-derived price after removal: ${err.message}`,
          ),
        );
    }

    this.actionHistoryService.record(userId, {
      entityType: "investment_transaction",
      entityId: beforeData.id as string,
      action: "delete",
      beforeData,
      description: `Deleted ${beforeData.action} transaction`,
    });
  }

  async getSummary(userId: string, accountIds?: string[]) {
    const query = this.investmentTransactionsRepository
      .createQueryBuilder("it")
      .where("it.userId = :userId", { userId });

    if (accountIds && accountIds.length > 0) {
      const resolvedIds = new Set<string>(accountIds);
      const accounts = await this.accountsService.findByIds(userId, accountIds);
      for (const acct of accounts) {
        if (acct.linkedAccountId) {
          resolvedIds.add(acct.linkedAccountId);
        }
      }
      const allIds = [...resolvedIds];
      query.andWhere("it.accountId IN (:...allIds)", { allIds });
    }

    const transactions = await query.getMany();

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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transactions = await queryRunner.manager.find(
        InvestmentTransaction,
        { where: { userId } },
      );
      const transactionsDeleted = transactions.length;

      // Delete linked cash transactions and reverse their balance effects
      const linkedCashTxIds = transactions
        .map((t) => t.transactionId)
        .filter((id): id is string => !!id);

      if (linkedCashTxIds.length > 0) {
        const cashTransactions = await queryRunner.manager.find(Transaction, {
          where: { id: In(linkedCashTxIds) },
        });

        for (const cashTx of cashTransactions) {
          if (cashTx.status !== TransactionStatus.VOID) {
            await this.accountsService.updateBalance(
              cashTx.accountId,
              -Number(cashTx.amount),
              queryRunner,
            );
          }
        }

        if (cashTransactions.length > 0) {
          await queryRunner.manager.remove(cashTransactions);
        }
      }

      if (transactions.length > 0) {
        await queryRunner.manager.remove(transactions);
      }

      const holdingsResult =
        await this.holdingsService.removeAllForUser(userId);

      const accountsReset =
        await this.accountsService.resetBrokerageBalances(userId);

      await queryRunner.commitTransaction();

      return {
        transactionsDeleted,
        holdingsDeleted: holdingsResult,
        accountsReset,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
