import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner, In } from "typeorm";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { CreateInvestmentTransactionDto } from "./dto/create-investment-transaction.dto";
import { UpdateInvestmentTransactionDto } from "./dto/update-investment-transaction.dto";
import { TransferSecurityDto } from "./dto/transfer-security.dto";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { HoldingsService } from "./holdings.service";
import {
  PortfolioCalculationService,
  RealizedGainEntry,
  CapitalGainEntry,
} from "./portfolio-calculation.service";
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
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  computeInvestmentCashImpact,
  isInvestmentActionAllowedInSplit,
} from "./cash-impact.util";

export type LlmInvestmentTxGroupBy = "account" | "date" | "security" | "action";

export type LlmCapitalGainsGroupBy = "month" | "security" | "account";

export interface LlmCapitalGainsEntry {
  month: string | null;
  accountName: string | null;
  symbol: string | null;
  securityName: string | null;
  /**
   * Currency the monetary fields are denominated in. `null` when the entry
   * aggregates rows from multiple accounts with different currencies (the LLM
   * should then treat the sums as mixed and avoid currency-specific claims).
   */
  currency: string | null;
  startValue: number;
  endValue: number;
  realizedGain: number;
  unrealizedGain: number;
  totalCapitalGain: number;
}

export interface LlmCapitalGainsResult {
  startDate: string;
  endDate: string;
  totals: {
    realizedGain: number;
    unrealizedGain: number;
    totalCapitalGain: number;
  };
  groupedBy: LlmCapitalGainsGroupBy;
  entries: LlmCapitalGainsEntry[];
  entryCount: number;
  truncatedEntryList: boolean;
}

export interface LlmInvestmentTxRow {
  transactionDate: string;
  action: string;
  accountName: string | null;
  symbol: string | null;
  securityName: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number;
  currency: string | null;
  description: string | null;
}

export interface LlmInvestmentTxGroup {
  key: string;
  transactionCount: number;
  totalQuantity: number;
  totalAmount: number;
  totalCommission: number;
}

export interface LlmInvestmentTransactionsResult {
  transactionCount: number;
  totalAmount: number;
  totalCommission: number;
  totalQuantity: number;
  actionCounts: Record<string, number>;
  groupedBy: LlmInvestmentTxGroupBy | null;
  groups: LlmInvestmentTxGroup[] | null;
  transactions: LlmInvestmentTxRow[];
  truncatedTransactionList: boolean;
}

@Injectable()
export class InvestmentTransactionsService {
  private readonly logger = new Logger(InvestmentTransactionsService.name);

  constructor(
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private dataSource: DataSource,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionsService))
    private transactionsService: TransactionsService,
    private holdingsService: HoldingsService,
    private portfolioCalculationService: PortfolioCalculationService,
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

    // Defer the live balance update for future-dated cash entries -- the
    // hourly applyDueTransactionBalances cron rolls them into currentBalance
    // when the user's local date catches up. Crediting now would double-count
    // once the cron runs.
    if (!isTransactionInFuture(investmentTransaction.transactionDate)) {
      await this.accountsService.updateBalance(
        cashAccount.id,
        cashAmount,
        queryRunner,
      );
    }

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
      // Only un-apply the balance if the cash transaction had been live --
      // a future-dated cash entry was never folded into currentBalance, so
      // there's nothing to reverse.
      if (!isTransactionInFuture(cashTransaction.transactionDate)) {
        await this.accountsService.updateBalance(
          cashTransaction.accountId,
          -Number(cashTransaction.amount),
          queryRunner,
        );
      }
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

    if (
      createDto.action === InvestmentAction.SPLIT &&
      (!createDto.quantity || Number(createDto.quantity) <= 0)
    ) {
      throw new BadRequestException(
        "Split ratio (quantity) must be greater than zero",
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

    // SPLIT mutations compound on the existing holding state, so a stray
    // residue from a bad import would survive an incremental update. Rebuild
    // holdings from the full transaction history to guarantee the user's
    // shares match what the ledger says.
    if (createDto.action === InvestmentAction.SPLIT) {
      await this.holdingsService
        .rebuildFromTransactions(userId)
        .catch((err) =>
          this.logger.warn(
            `Holdings rebuild after SPLIT create failed: ${err.message}`,
          ),
        );
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

  /**
   * Move a security between two investment accounts while preserving cost
   * basis. Creates both legs atomically: a TRANSFER_OUT in the source account
   * (drawn down at the source's running average cost) and a TRANSFER_IN in the
   * destination account at `costPerShare`. No cash transaction is created --
   * shares move only, no money changes hands -- so both legs use exchangeRate 1
   * and have a null linked cash transaction.
   */
  async transferSecurity(
    userId: string,
    dto: TransferSecurityDto,
  ): Promise<{
    transferOut: InvestmentTransaction;
    transferIn: InvestmentTransaction;
  }> {
    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException(
        "Source and destination accounts must be different",
      );
    }

    const [fromAccount, toAccount] = await Promise.all([
      this.accountsService.findOne(userId, dto.fromAccountId),
      this.accountsService.findOne(userId, dto.toAccountId),
    ]);

    if (
      fromAccount.accountType !== "INVESTMENT" ||
      toAccount.accountType !== "INVESTMENT"
    ) {
      throw new BadRequestException("Both accounts must be of type INVESTMENT");
    }

    await this.securitiesService.findOne(userId, dto.securityId);

    // Transfer legs carry no cash, so totalAmount is 0 -- matching how
    // calculateTotalAmount() treats TRANSFER_IN/TRANSFER_OUT on the edit path.
    // Cost basis flows through quantity * price (per-share cost) instead.
    const totalAmount = 0;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let outId: string;
    let inId: string;

    try {
      const transferOut = queryRunner.manager.create(InvestmentTransaction, {
        userId,
        accountId: dto.fromAccountId,
        securityId: dto.securityId,
        fundingAccountId: null,
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: dto.transactionDate,
        quantity: dto.quantity,
        price: dto.costPerShare,
        commission: 0,
        totalAmount,
        exchangeRate: 1,
        description: dto.description,
      });
      const savedOut = await queryRunner.manager.save(transferOut);
      outId = savedOut.id;
      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        savedOut,
        false,
        false,
      );

      const transferIn = queryRunner.manager.create(InvestmentTransaction, {
        userId,
        accountId: dto.toAccountId,
        securityId: dto.securityId,
        fundingAccountId: null,
        action: InvestmentAction.TRANSFER_IN,
        transactionDate: dto.transactionDate,
        quantity: dto.quantity,
        price: dto.costPerShare,
        commission: 0,
        totalAmount,
        exchangeRate: 1,
        description: dto.description,
      });
      const savedIn = await queryRunner.manager.save(transferIn);
      inId = savedIn.id;
      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        savedIn,
        false,
        false,
      );

      // Guard against transferring more than the source holds. Validates the
      // full replayed history so it catches both the immediate over-draw and
      // any back-dated transfer that would make a past balance go negative.
      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        queryRunner,
        [dto.fromAccountId, dto.toAccountId],
        [dto.securityId],
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.triggerRecalcWithCashAccount(dto.fromAccountId, userId);
    this.triggerRecalcWithCashAccount(dto.toAccountId, userId);

    this.securityPriceService
      .upsertTransactionPrice(dto.securityId, dto.transactionDate)
      .catch((err) =>
        this.logger.warn(
          `Failed to update transaction-derived price: ${err.message}`,
        ),
      );

    const [transferOut, transferIn] = await Promise.all([
      this.findOne(userId, outId),
      this.findOne(userId, inId),
    ]);

    this.actionHistoryService.record(userId, {
      entityType: "investment_transaction",
      entityId: transferOut.id,
      action: "create",
      afterData: {
        transferOut: { ...transferOut },
        transferIn: { ...transferIn },
      },
      description: "Transferred security between accounts",
    });

    return { transferOut, transferIn };
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
    allowNegative: boolean = false,
    createCashSide: boolean = true,
  ): Promise<void> {
    // Future-dated investments: still create the linked cash transaction so
    // it shows in the cash account ledger as a projected entry (matching how
    // every other future-dated transaction is rendered). Skip the Holdings
    // update -- holdings are a stateful "as of now" record and shouldn't
    // anticipate a purchase that hasn't settled yet. The applyDueTransactionBalances
    // cron rolls the cash balance forward when the date arrives; an explicit
    // backfill of holdings happens via update()/remove() reverse+reapply paths
    // when the user later edits the transaction.
    const isFuture = isTransactionInFuture(transaction.transactionDate);

    const {
      action,
      accountId,
      securityId,
      quantity,
      price,
      totalAmount,
      fundingAccountId,
    } = transaction;

    // Cash account is only needed when we're creating the linked cash transaction.
    // Embedded-in-split investment transactions skip cash creation because the
    // parent split's amount IS the cash side.
    let cashAccount: Account | null = null;
    if (createCashSide) {
      if (fundingAccountId) {
        cashAccount = await this.accountsService.findOne(
          userId,
          fundingAccountId,
        );
      } else {
        cashAccount = await this.findCashAccount(userId, accountId);
      }
    }
    let cashTransactionId: string | null = null;

    switch (action) {
      case InvestmentAction.BUY:
        if (!isFuture) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId!,
            Number(quantity),
            Number(price),
            queryRunner,
            allowNegative,
          );
        }
        if (createCashSide && cashAccount) {
          cashTransactionId = await this.createCashTransactionInTransaction(
            queryRunner,
            userId,
            cashAccount,
            transaction,
            -Number(totalAmount),
          );
        }
        break;

      case InvestmentAction.SELL:
        if (!isFuture) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId!,
            -Number(quantity),
            Number(price),
            queryRunner,
            allowNegative,
          );
        }
        if (createCashSide && cashAccount) {
          cashTransactionId = await this.createCashTransactionInTransaction(
            queryRunner,
            userId,
            cashAccount,
            transaction,
            Number(totalAmount),
          );
        }
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        if (createCashSide && cashAccount) {
          cashTransactionId = await this.createCashTransactionInTransaction(
            queryRunner,
            userId,
            cashAccount,
            transaction,
            Number(totalAmount),
          );
        }
        break;

      case InvestmentAction.REINVEST:
        if (!isFuture && securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
            queryRunner,
            allowNegative,
          );
        }
        break;

      case InvestmentAction.SPLIT:
        // Stock split: scale quantity by the ratio and divide averageCost by
        // the same ratio so total cost basis is preserved. The optional
        // `price` carries the post-split per-share market price for
        // reporting; the cost basis comes from the existing holding, not
        // from `price`.
        if (!isFuture && securityId && quantity) {
          await this.holdingsService.applySplit(
            accountId,
            securityId,
            Number(quantity),
            queryRunner,
          );
        }
        break;

      case InvestmentAction.TRANSFER_IN:
        if (!isFuture && securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            Number(quantity),
            Number(price),
            queryRunner,
            allowNegative,
          );
        }
        break;

      case InvestmentAction.TRANSFER_OUT:
        if (!isFuture && securityId && quantity && price) {
          await this.holdingsService.updateHolding(
            userId,
            accountId,
            securityId,
            -Number(quantity),
            Number(price),
            queryRunner,
            allowNegative,
          );
        }
        break;

      case InvestmentAction.ADD_SHARES:
        if (!isFuture && securityId && quantity) {
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
        if (!isFuture && securityId && quantity) {
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

  /**
   * Create an InvestmentTransaction that is embedded inside a parent split
   * transaction. The parent split's amount represents the cash side, so this
   * path skips the auto-generated linked cash Transaction (transactionId stays
   * null) and only updates Holdings.
   *
   * Reuses the same cash-impact computation, exchange-rate resolution, and
   * holdings logic as `create()` so embedded rows behave identically to
   * free-standing ones in portfolio reports.
   */
  async createEmbeddedForSplit(
    queryRunner: QueryRunner,
    userId: string,
    parentTransactionDate: string,
    parentSplitId: string,
    brokerageAccountId: string,
    cashAccountId: string,
    dto: {
      action: InvestmentAction;
      securityId?: string | null;
      quantity?: number | null;
      price?: number | null;
      commission?: number | null;
      exchangeRate?: number | null;
      description?: string | null;
    },
  ): Promise<InvestmentTransaction> {
    if (!isInvestmentActionAllowedInSplit(dto.action)) {
      throw new BadRequestException(
        `Investment action ${dto.action} is not allowed inside a split transaction`,
      );
    }

    const brokerageAccount = await this.accountsService.findOne(
      userId,
      brokerageAccountId,
    );
    if (
      brokerageAccount.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE
    ) {
      throw new BadRequestException(
        "Embedded investment splits require an INVESTMENT_BROKERAGE account",
      );
    }

    const securityRequiredActions = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.REINVEST,
      InvestmentAction.DIVIDEND,
      InvestmentAction.CAPITAL_GAIN,
    ];
    if (securityRequiredActions.includes(dto.action) && !dto.securityId) {
      throw new BadRequestException(
        `Security ID is required for ${dto.action} transactions`,
      );
    }

    if (dto.securityId) {
      await this.securitiesService.findOne(userId, dto.securityId);
    }

    const totalAmount = Math.abs(
      computeInvestmentCashImpact(
        dto.action,
        Number(dto.quantity ?? 0),
        Number(dto.price ?? 0),
        Number(dto.commission ?? 0),
      ),
    );

    const exchangeRate = await this.resolveCashExchangeRate(
      userId,
      brokerageAccountId,
      cashAccountId,
      dto.securityId ?? null,
      dto.exchangeRate ?? undefined,
    );

    const investmentTransaction = queryRunner.manager.create(
      InvestmentTransaction,
      {
        userId,
        accountId: brokerageAccountId,
        securityId: dto.securityId ?? null,
        fundingAccountId: null,
        transactionId: null,
        transactionSplitId: parentSplitId,
        action: dto.action,
        transactionDate: parentTransactionDate,
        quantity: dto.quantity ?? 0,
        price: dto.price ?? 0,
        commission: dto.commission ?? 0,
        totalAmount,
        exchangeRate,
        description: dto.description ?? null,
      },
    );

    const saved = await queryRunner.manager.save(investmentTransaction);

    await this.processTransactionEffectsInTransaction(
      queryRunner,
      userId,
      saved,
      false,
      false,
    );

    return saved;
  }

  /**
   * Reverse the holdings effects of an embedded investment transaction and
   * delete the row. The parent split's deletion would cascade-delete this row
   * via the FK, but we need the holdings reversal to happen first.
   */
  async reverseAndRemoveEmbedded(
    queryRunner: QueryRunner,
    userId: string,
    investmentTransaction: InvestmentTransaction,
  ): Promise<void> {
    await this.reverseTransactionEffectsInTransaction(
      queryRunner,
      userId,
      investmentTransaction,
    );
    await queryRunner.manager.remove(investmentTransaction);
  }

  /**
   * Sync a split transaction's parent after one of its embedded investment
   * rows changes. Recomputes the split's cash-side amount from the saved
   * investment row, re-sums all sibling splits to derive the parent
   * transaction's new amount, and applies the delta to the cash account so
   * its balance stays consistent.
   */
  private async updateEmbeddedSplitParent(
    queryRunner: QueryRunner,
    userId: string,
    saved: InvestmentTransaction,
    splitId: string,
  ): Promise<void> {
    const cashImpactInSecurity = computeInvestmentCashImpact(
      saved.action,
      Number(saved.quantity ?? 0),
      Number(saved.price ?? 0),
      Number(saved.commission ?? 0),
    );
    const newSplitAmount = roundToDecimals(
      cashImpactInSecurity * Number(saved.exchangeRate),
      4,
    );

    const split = await queryRunner.manager.findOne(TransactionSplit, {
      where: { id: splitId },
    });
    if (!split) {
      throw new NotFoundException(
        `Transaction split ${splitId} not found for embedded investment update`,
      );
    }

    await queryRunner.manager.update(TransactionSplit, splitId, {
      amount: newSplitAmount,
    });

    const parentTransaction = await queryRunner.manager.findOne(Transaction, {
      where: { id: split.transactionId, userId },
    });
    if (!parentTransaction) {
      throw new NotFoundException(
        `Parent transaction ${split.transactionId} not found for embedded investment update`,
      );
    }

    const siblingSplits = await queryRunner.manager.find(TransactionSplit, {
      where: { transactionId: split.transactionId },
    });
    const newParentTotalCents = siblingSplits.reduce((sum, s) => {
      const amt = s.id === splitId ? newSplitAmount : Number(s.amount);
      return sum + Math.round(amt * 10000);
    }, 0);
    const newParentAmount = newParentTotalCents / 10000;
    const oldParentAmount = Number(parentTransaction.amount);
    const delta = roundToDecimals(newParentAmount - oldParentAmount, 4);

    await queryRunner.manager.update(Transaction, parentTransaction.id, {
      amount: newParentAmount,
    });

    if (delta !== 0) {
      if (isTransactionInFuture(parentTransaction.transactionDate)) {
        await this.accountsService.recalculateCurrentBalance(
          parentTransaction.accountId,
          queryRunner,
        );
      } else {
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          delta,
          queryRunner,
        );
      }
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
      .addOrderBy("it.createdAt", "DESC")
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

  /**
   * Return each SELL transaction annotated with cost basis and realized gain,
   * computed by replaying the user's transaction history under the
   * average-cost method. Linked brokerage/cash accounts are resolved the same
   * way as `findAll()` so filtering by either side yields consistent results.
   */
  async getRealizedGains(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<RealizedGainEntry[]> {
    let accountIds = opts.accountIds;
    if (accountIds && accountIds.length > 0) {
      const resolvedIds = new Set<string>(accountIds);
      const accounts = await this.accountsService.findByIds(userId, accountIds);
      for (const acct of accounts) {
        if (acct.linkedAccountId) resolvedIds.add(acct.linkedAccountId);
      }
      accountIds = [...resolvedIds];
    }

    return this.portfolioCalculationService.calculateRealizedGains(userId, {
      accountIds,
      startDate: opts.startDate,
      endDate: opts.endDate,
    });
  }

  /**
   * Per-month capital gain breakdown (realized + unrealized) per security in
   * the requested window. Resolves linked brokerage/cash accounts the same way
   * `findAll()` and `getRealizedGains()` do so callers can filter by either
   * side and get a consistent picture.
   */
  async getCapitalGainsByMonth(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
    },
  ): Promise<CapitalGainEntry[]> {
    let accountIds = opts.accountIds;
    if (accountIds && accountIds.length > 0) {
      const resolvedIds = new Set<string>(accountIds);
      const accounts = await this.accountsService.findByIds(userId, accountIds);
      for (const acct of accounts) {
        if (acct.linkedAccountId) resolvedIds.add(acct.linkedAccountId);
      }
      accountIds = [...resolvedIds];
    }

    return this.portfolioCalculationService.calculateCapitalGainsByMonth(
      userId,
      {
        accountIds,
        startDate: opts.startDate,
        endDate: opts.endDate,
      },
    );
  }

  /**
   * Per-day capital gain breakdown (realized + unrealized) per security in
   * the requested window. Same account resolution as getCapitalGainsByMonth.
   */
  async getCapitalGainsByDay(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
    },
  ): Promise<CapitalGainEntry[]> {
    let accountIds = opts.accountIds;
    if (accountIds && accountIds.length > 0) {
      const resolvedIds = new Set<string>(accountIds);
      const accounts = await this.accountsService.findByIds(userId, accountIds);
      for (const acct of accounts) {
        if (acct.linkedAccountId) resolvedIds.add(acct.linkedAccountId);
      }
      accountIds = [...resolvedIds];
    }

    return this.portfolioCalculationService.calculateCapitalGainsByDay(userId, {
      accountIds,
      startDate: opts.startDate,
      endDate: opts.endDate,
    });
  }

  /**
   * LLM-friendly capital-gains roll-up sharing logic with the report endpoint
   * and the MCP server. Replays the user's investment history via
   * PortfolioCalculationService.calculateCapitalGainsByMonth, optionally
   * narrows by symbol, and aggregates into buckets ('month', 'security', or
   * 'account') so the assistant gets a compact shape with period totals.
   *
   * All monetary values are in the holding account's currency. When a bucket
   * spans accounts with differing currencies, its `currency` is set to `null`
   * so callers can tell the sum is mixed.
   */
  async getLlmCapitalGains(
    userId: string,
    options: {
      startDate: string;
      endDate: string;
      accountIds?: string[];
      symbols?: string[];
      groupBy?: LlmCapitalGainsGroupBy;
    },
  ): Promise<LlmCapitalGainsResult> {
    let accountIds = options.accountIds;
    if (accountIds && accountIds.length > 0) {
      const resolvedIds = new Set<string>(accountIds);
      const accounts = await this.accountsService.findByIds(userId, accountIds);
      for (const acct of accounts) {
        if (acct.linkedAccountId) resolvedIds.add(acct.linkedAccountId);
      }
      accountIds = [...resolvedIds];
    }

    const raw =
      await this.portfolioCalculationService.calculateCapitalGainsByMonth(
        userId,
        {
          accountIds,
          startDate: options.startDate,
          endDate: options.endDate,
        },
      );

    const upperSymbols = options.symbols?.length
      ? new Set(options.symbols.map((s) => s.toUpperCase()))
      : null;
    const filtered = upperSymbols
      ? raw.filter((e) => e.symbol && upperSymbols.has(e.symbol.toUpperCase()))
      : raw;

    const groupBy: LlmCapitalGainsGroupBy = options.groupBy ?? "month";

    // Aggregate in integer 1e-4 units so sums stay free of float drift.
    const round4 = (n: number): number => Math.round(n * 10000) / 10000;
    interface Bucket {
      month: string | null;
      accountName: string | null;
      symbol: string | null;
      securityName: string | null;
      currency: string | null | undefined; // undefined = not seen yet
      startValueScaled: number;
      endValueScaled: number;
      realizedScaled: number;
      unrealizedScaled: number;
      totalScaled: number;
    }
    const buckets = new Map<string, Bucket>();
    let totalsRealizedScaled = 0;
    let totalsUnrealizedScaled = 0;
    let totalsCapitalScaled = 0;

    for (const e of filtered) {
      totalsRealizedScaled += Math.round(e.realizedGain * 10000);
      totalsUnrealizedScaled += Math.round(e.unrealizedGain * 10000);
      totalsCapitalScaled += Math.round(e.totalCapitalGain * 10000);

      let key: string;
      let seed: Pick<
        Bucket,
        "month" | "accountName" | "symbol" | "securityName"
      >;
      if (groupBy === "month") {
        key = e.month;
        seed = {
          month: e.month,
          accountName: null,
          symbol: null,
          securityName: null,
        };
      } else if (groupBy === "security") {
        key = e.symbol ?? `__sec:${e.securityId}`;
        seed = {
          month: null,
          accountName: null,
          symbol: e.symbol,
          securityName: e.securityName,
        };
      } else {
        key = e.accountName ?? `__acct:${e.accountId}`;
        seed = {
          month: null,
          accountName: e.accountName,
          symbol: null,
          securityName: null,
        };
      }

      let b = buckets.get(key);
      if (!b) {
        b = {
          ...seed,
          currency: undefined,
          startValueScaled: 0,
          endValueScaled: 0,
          realizedScaled: 0,
          unrealizedScaled: 0,
          totalScaled: 0,
        };
        buckets.set(key, b);
      }

      // Track currency: consistent → keep it; mixed → null.
      if (b.currency === undefined) {
        b.currency = e.accountCurrencyCode;
      } else if (b.currency !== e.accountCurrencyCode) {
        b.currency = null;
      }

      b.startValueScaled += Math.round(e.startValue * 10000);
      b.endValueScaled += Math.round(e.endValue * 10000);
      b.realizedScaled += Math.round(e.realizedGain * 10000);
      b.unrealizedScaled += Math.round(e.unrealizedGain * 10000);
      b.totalScaled += Math.round(e.totalCapitalGain * 10000);
    }

    const MAX_ENTRIES = 100;
    const allEntries: LlmCapitalGainsEntry[] = [...buckets.values()].map(
      (b) => ({
        month: b.month,
        accountName: b.accountName,
        symbol: b.symbol,
        securityName: b.securityName,
        currency: b.currency ?? null,
        startValue: round4(b.startValueScaled / 10000),
        endValue: round4(b.endValueScaled / 10000),
        realizedGain: round4(b.realizedScaled / 10000),
        unrealizedGain: round4(b.unrealizedScaled / 10000),
        totalCapitalGain: round4(b.totalScaled / 10000),
      }),
    );
    allEntries.sort((a, b) => {
      if (groupBy === "month")
        return (a.month ?? "").localeCompare(b.month ?? "");
      return b.totalCapitalGain - a.totalCapitalGain;
    });

    return {
      startDate: options.startDate,
      endDate: options.endDate,
      totals: {
        realizedGain: round4(totalsRealizedScaled / 10000),
        unrealizedGain: round4(totalsUnrealizedScaled / 10000),
        totalCapitalGain: round4(totalsCapitalScaled / 10000),
      },
      groupedBy: groupBy,
      entries: allEntries.slice(0, MAX_ENTRIES),
      entryCount: allEntries.length,
      truncatedEntryList: allEntries.length > MAX_ENTRIES,
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
    const isEmbedded = transaction.transactionSplitId != null;

    if (isEmbedded) {
      // Embedded rows are pinned to their parent split: account, funding, and
      // date come from the parent transaction. Letting the API mutate them
      // here would silently desync the parent's cash side from the investment
      // row. Anything else (action, security, qty, price, commission, fx,
      // description) is fine -- those changes flow back into the parent
      // split's amount below.
      if (
        updateDto.accountId !== undefined &&
        updateDto.accountId !== transaction.accountId
      ) {
        throw new BadRequestException(
          "Cannot change the account of an investment split; remove the split and add it on the new account instead",
        );
      }
      if (
        updateDto.fundingAccountId !== undefined &&
        (updateDto.fundingAccountId || null) !== transaction.fundingAccountId
      ) {
        throw new BadRequestException(
          "Investment splits do not use a separate funding account",
        );
      }
      if (
        updateDto.transactionDate !== undefined &&
        updateDto.transactionDate !== transaction.transactionDate
      ) {
        throw new BadRequestException(
          "Cannot change the date of an investment split; edit the parent split transaction date instead",
        );
      }
      const effectiveAction = updateDto.action ?? transaction.action;
      if (!isInvestmentActionAllowedInSplit(effectiveAction)) {
        throw new BadRequestException(
          `Investment action ${effectiveAction} is not allowed inside a split transaction`,
        );
      }
    }

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
      if (updateDto.accountId !== undefined) {
        transaction.accountId = updateDto.accountId;
        // findOne's leftJoinAndSelect populated `account`; if we mutate only
        // the FK column, TypeORM's save() will re-derive the column from the
        // still-stale relation and silently revert the change. Point the
        // relation stub at the new id to keep them in sync.
        transaction.account = { id: updateDto.accountId } as any;
      }
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
      if (updateDto.securityId !== undefined) {
        transaction.securityId = updateDto.securityId;
        transaction.security = updateDto.securityId
          ? ({ id: updateDto.securityId } as any)
          : (null as any);
      }
      if (updateDto.fundingAccountId !== undefined) {
        transaction.fundingAccountId = updateDto.fundingAccountId || null;
        // Same reason as accountId above: keep the eager-loaded relation in
        // sync with the new FK so save() doesn't write back the old one.
        transaction.fundingAccount = transaction.fundingAccountId
          ? ({ id: transaction.fundingAccountId } as any)
          : null;
      }
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

      if (
        transaction.action === InvestmentAction.SPLIT &&
        (transaction.quantity === null ||
          transaction.quantity === undefined ||
          Number(transaction.quantity) <= 0)
      ) {
        throw new BadRequestException(
          "Split ratio (quantity) must be greater than zero",
        );
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

      // Apply the new transaction effects. Allow intermediate negative
      // holdings so editing a past transaction is not blocked by the
      // current (possibly zero) balance. Correctness is enforced by the
      // history check below, which replays the affected accounts'
      // transactions in chronological order.
      //
      // For embedded splits, the parent transaction owns the cash side --
      // skip the standalone cash-transaction path and instead reflect the
      // new cash impact into the parent split + parent transaction amount.
      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        saved,
        true,
        !isEmbedded,
      );

      if (isEmbedded) {
        await this.updateEmbeddedSplitParent(
          queryRunner,
          userId,
          saved,
          transaction.transactionSplitId!,
        );
      }

      // Scope validation to the accounts AND securities this edit could
      // have affected (old + new if either changed). Validating every
      // (account, security) pair would falsely blame this edit for
      // pre-existing oversold states in unrelated securities elsewhere
      // in the user's data — e.g. editing a 2026 trade in security A
      // surfacing a 2009 oversell of security B.
      const affectedAccountIds = Array.from(
        new Set([accountId, saved.accountId].filter(Boolean) as string[]),
      );
      const affectedSecurityIds = Array.from(
        new Set([oldSecurityId, saved.securityId].filter(Boolean) as string[]),
      );
      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        queryRunner,
        affectedAccountIds,
        affectedSecurityIds.length > 0 ? affectedSecurityIds : undefined,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // If a SPLIT was touched (either before or after the edit), rebuild
    // holdings from history -- the incremental reverse/re-apply assumes
    // the original transaction was correctly applied, which isn't true
    // for splits that came in from older buggy imports.
    if (
      oldAction === InvestmentAction.SPLIT ||
      transaction.action === InvestmentAction.SPLIT
    ) {
      await this.holdingsService
        .rebuildFromTransactions(userId)
        .catch((err) =>
          this.logger.warn(
            `Holdings rebuild after SPLIT update failed: ${err.message}`,
          ),
        );
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
    isFutureOverride?: boolean,
  ): Promise<void> {
    // Cash transactions are now created for future-dated investments too
    // (they show as projected entries in the cash account ledger), so always
    // tear down the linked Transaction even when the date is still in the
    // future. Only the Holdings reversal is skipped for future dates -- the
    // forward path didn't update Holdings then either, so there's nothing
    // to undo. The optional isFutureOverride lets update() pin the decision
    // to the OLD date even when the in-memory `transaction` already reflects
    // a new (past) date.
    const isFuture =
      isFutureOverride ?? isTransactionInFuture(transaction.transactionDate);

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

    if (isFuture) {
      // Holdings were never updated for this future-dated row, so nothing
      // to undo on that side.
      return;
    }

    // Reversing a past transaction can make the running Holding balance
    // temporarily negative (e.g. reversing a BUY when the user has since
    // sold the position). Allow that intermediate state; the update/remove
    // callers validate the full transaction history before commit.
    const allowNegative = true;

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
            allowNegative,
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
            allowNegative,
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
            allowNegative,
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
            allowNegative,
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
            allowNegative,
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

      case InvestmentAction.SPLIT:
        if (securityId && quantity) {
          await this.holdingsService.reverseSplit(
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

      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        queryRunner,
        [accountId],
        transaction.securityId ? [transaction.securityId] : undefined,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (transaction.action === InvestmentAction.SPLIT) {
      await this.holdingsService
        .rebuildFromTransactions(userId)
        .catch((err) =>
          this.logger.warn(
            `Holdings rebuild after SPLIT remove failed: ${err.message}`,
          ),
        );
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

  /**
   * Compact investment-transaction query for LLM / AI consumers. Called by
   * both the AI Assistant's tool executor and the MCP server's
   * `query_investment_transactions` tool so the two surfaces return the same
   * shape. Monetary values are rounded to 4 decimals, quantities to 8.
   *
   * Filters: account, security symbol, action, and date range.
   * Grouping: by account, date, security (symbol), or action. When grouped,
   * each bucket carries per-group totals; when not grouped, a capped list of
   * the most recent matching transactions is returned alongside aggregate
   * totals so the LLM can cite individual rows.
   */
  async getLlmInvestmentTransactions(
    userId: string,
    options: {
      startDate?: string;
      endDate?: string;
      accountIds?: string[];
      symbols?: string[];
      actions?: InvestmentAction[];
      groupBy?: LlmInvestmentTxGroupBy;
    },
  ): Promise<LlmInvestmentTransactionsResult> {
    const query = this.investmentTransactionsRepository
      .createQueryBuilder("it")
      .leftJoinAndSelect("it.account", "account")
      .leftJoinAndSelect("it.security", "security")
      .where("it.userId = :userId", { userId });

    if (options.accountIds && options.accountIds.length > 0) {
      const resolvedIds = new Set<string>(options.accountIds);
      const accounts = await this.accountsService.findByIds(
        userId,
        options.accountIds,
      );
      for (const acct of accounts) {
        if (acct.linkedAccountId) resolvedIds.add(acct.linkedAccountId);
      }
      const allIds = [...resolvedIds];
      query.andWhere("it.accountId IN (:...allIds)", { allIds });
    }

    if (options.startDate) {
      query.andWhere("it.transactionDate >= :startDate", {
        startDate: options.startDate,
      });
    }
    if (options.endDate) {
      query.andWhere("it.transactionDate <= :endDate", {
        endDate: options.endDate,
      });
    }
    if (options.symbols && options.symbols.length > 0) {
      const upperSymbols = options.symbols.map((s) => s.toUpperCase());
      query.andWhere("UPPER(security.symbol) IN (:...upperSymbols)", {
        upperSymbols,
      });
    }
    if (options.actions && options.actions.length > 0) {
      query.andWhere("it.action IN (:...actions)", {
        actions: options.actions,
      });
    }

    query
      .orderBy("it.transactionDate", "DESC")
      .addOrderBy("it.createdAt", "DESC");

    const rows = await query.getMany();

    const round4 = (n: number): number => Math.round(n * 10000) / 10000;
    const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

    let totalAmountScaled = 0;
    let totalCommissionScaled = 0;
    let totalQuantityScaled = 0;
    const actionCounts: Record<string, number> = {};

    for (const r of rows) {
      totalAmountScaled += Math.round(Number(r.totalAmount) * 10000);
      totalCommissionScaled += Math.round(Number(r.commission || 0) * 10000);
      if (r.quantity !== null && r.quantity !== undefined) {
        totalQuantityScaled += Math.round(Number(r.quantity) * 1e8);
      }
      actionCounts[r.action] = (actionCounts[r.action] || 0) + 1;
    }

    const MAX_LISTED = 100;
    const transactions: LlmInvestmentTxRow[] = rows
      .slice(0, MAX_LISTED)
      .map((r) => ({
        transactionDate: r.transactionDate,
        action: r.action,
        accountName: r.account?.name ?? null,
        symbol: r.security?.symbol ?? null,
        securityName: r.security?.name ?? null,
        quantity:
          r.quantity !== null && r.quantity !== undefined
            ? round8(Number(r.quantity))
            : null,
        price:
          r.price !== null && r.price !== undefined
            ? round4(Number(r.price))
            : null,
        commission: round4(Number(r.commission || 0)),
        totalAmount: round4(Number(r.totalAmount)),
        currency: r.account?.currencyCode ?? null,
        description: r.description ?? null,
      }));

    let groups: LlmInvestmentTxGroup[] | null = null;
    if (options.groupBy) {
      const buckets = new Map<
        string,
        {
          amountScaled: number;
          commissionScaled: number;
          quantityScaled: number;
          count: number;
        }
      >();
      for (const r of rows) {
        const key = this.getLlmInvestmentGroupKey(r, options.groupBy);
        const b = buckets.get(key) ?? {
          amountScaled: 0,
          commissionScaled: 0,
          quantityScaled: 0,
          count: 0,
        };
        b.amountScaled += Math.round(Number(r.totalAmount) * 10000);
        b.commissionScaled += Math.round(Number(r.commission || 0) * 10000);
        if (r.quantity !== null && r.quantity !== undefined) {
          b.quantityScaled += Math.round(Number(r.quantity) * 1e8);
        }
        b.count += 1;
        buckets.set(key, b);
      }
      groups = [...buckets.entries()]
        .map(([key, b]) => ({
          key,
          transactionCount: b.count,
          totalQuantity: round8(b.quantityScaled / 1e8),
          totalAmount: round4(b.amountScaled / 10000),
          totalCommission: round4(b.commissionScaled / 10000),
        }))
        .sort((a, b) =>
          options.groupBy === "date"
            ? b.key.localeCompare(a.key)
            : b.totalAmount - a.totalAmount,
        );
    }

    return {
      transactionCount: rows.length,
      totalAmount: round4(totalAmountScaled / 10000),
      totalCommission: round4(totalCommissionScaled / 10000),
      totalQuantity: round8(totalQuantityScaled / 1e8),
      actionCounts,
      groupedBy: options.groupBy ?? null,
      groups,
      transactions,
      truncatedTransactionList: rows.length > MAX_LISTED,
    };
  }

  private getLlmInvestmentGroupKey(
    row: InvestmentTransaction,
    groupBy: LlmInvestmentTxGroupBy,
  ): string {
    switch (groupBy) {
      case "account":
        return row.account?.name ?? row.accountId;
      case "date":
        return row.transactionDate;
      case "security":
        return row.security?.symbol ?? "(no security)";
      case "action":
        return row.action;
    }
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
