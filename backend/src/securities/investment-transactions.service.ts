import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner, In } from "typeorm";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Security } from "./entities/security.entity";
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
import { roundToDecimals, roundMoney, sumMoney } from "../common/round.util";
import { stripHtml } from "../common/sanitization.util";
import {
  BulkCreateResult,
  BulkCreateSkip,
  bulkSkipReason,
} from "../common/bulk-create.types";
import {
  buildPaginationMeta,
  clampPagination,
  PaginatedResult,
} from "../common/dto/pagination-query.dto";
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
import {
  AiActionPreviewRow,
  BatchUpdateInvestmentTransactionRow,
  BatchDeleteInvestmentTransactionRow,
} from "../ai/actions/ai-action.types";

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

/** One account a security has been transacted in (including closed ones). */
export interface SecurityHistoryAccount {
  accountId: string;
  accountName: string;
  isClosed: boolean;
  /** Exact (un-snapped) current share balance in this account. */
  currentQuantity: number;
}

/** A single transaction in a security's history, with running share balances. */
export interface SecurityHistoryTransaction {
  id: string;
  transactionDate: string;
  accountId: string;
  accountName: string;
  action: InvestmentAction;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number;
  description: string | null;
  /** Running share balance within this transaction's own account. */
  runningQuantityAccount: number;
  /** Running share balance across all accounts the security is held in. */
  runningQuantityAll: number;
}

export interface SecurityTransactionHistory {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  accounts: SecurityHistoryAccount[];
  transactions: SecurityHistoryTransaction[];
  /** Exact (un-snapped) total current shares across all accounts. */
  currentQuantityAll: number;
}

/**
 * Resolved, validated preview of a proposed investment transaction -- the
 * dry-run shape shared by the AI Assistant confirmation flow and the MCP
 * `create_investment_transaction` tool. Mirrors exactly what `create()` would
 * persist: quantities/prices/commission are rounded to their column scale, the
 * total and exchange rate use the same math as the real write, and the cash
 * fields describe the linked cash movement so a confirmation card can show it.
 */
export interface CreateInvestmentTransactionPreview {
  accountId: string;
  accountName: string;
  accountCurrency: string;
  action: InvestmentAction;
  transactionDate: string;
  securityId: string | null;
  symbol: string | null;
  securityName: string | null;
  securityCurrency: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  /** Magnitude of the transaction in the security's currency (stored totalAmount). */
  totalAmount: number;
  /** Rate converting the security's currency into the cash account's currency. */
  exchangeRate: number;
  fundingAccountId: string | null;
  /**
   * Account whose cash balance moves (an explicit funding account, or the
   * brokerage's linked cash sleeve). Null when the action moves no cash.
   */
  cashAccountName: string | null;
  cashCurrency: string | null;
  /** Signed cash impact in the cash account's currency (negative = cash out). */
  cashAmount: number | null;
  description: string | null;
}

/**
 * Resolved preview of an edit to an existing investment transaction. Carries
 * the full resulting state (computed exactly like a create) plus the id being
 * edited, so the confirmation card matches the create flow and the signed
 * descriptor can apply an idempotent overwrite.
 */
export interface UpdateInvestmentTransactionPreview extends CreateInvestmentTransactionPreview {
  transactionId: string;
}

/**
 * One create row for the unified `manage_investment_transactions` tool, carrying
 * NAMES (resolved internally) so neither tool surface has to look up account or
 * security IDs first.
 */
export interface InvestmentCreateRowInput {
  accountName: string;
  action: InvestmentAction;
  date: string;
  securityQuery?: string;
  quantity?: number;
  price?: number;
  commission?: number;
  fundingAccountName?: string;
  description?: string;
}

/** One edit row for `manage_investment_transactions` (id + optional fields). */
export interface InvestmentUpdateRowInput {
  transactionId: string;
  action?: InvestmentAction;
  date?: string;
  securityQuery?: string;
  quantity?: number;
  price?: number;
  commission?: number;
  description?: string;
}

/**
 * Bulk preview of investment creates: the resolved previews that will be
 * created (`okPreviews`, mapped into the signed descriptor in order) plus the
 * full display table (`previewRows`, every row valid or flagged) and the
 * best-effort `skipped` reasons.
 */
export interface PrepareInvestmentCreateBulkResult {
  okPreviews: CreateInvestmentTransactionPreview[];
  okIndex: number[];
  previewRows: AiActionPreviewRow[];
  skipped: BulkCreateSkip[];
}

/** Bulk preview of investment edits mapped to batch rows + a display table. */
export interface PrepareInvestmentUpdateBulkResult {
  okRows: BatchUpdateInvestmentTransactionRow[];
  okIndex: number[];
  previewRows: AiActionPreviewRow[];
  skipped: BulkCreateSkip[];
}

/** Bulk preview of investment deletions mapped to batch rows + a display table. */
export interface PrepareInvestmentDeleteBulkResult {
  okRows: BatchDeleteInvestmentTransactionRow[];
  okIndex: number[];
  previewRows: AiActionPreviewRow[];
  skipped: BulkCreateSkip[];
}

/** Display-only preview of a proposed investment-transaction deletion. */
export interface DeleteInvestmentTransactionPreview {
  transactionId: string;
  accountName: string;
  action: InvestmentAction;
  transactionDate: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrency: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number;
  description: string | null;
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
      throw new BadRequestException(
        tr(
          "errors.securities.accountMustBeInvestment",
          "Account must be of type INVESTMENT",
        ),
      );
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
        tr(
          "errors.securities.securityIdRequired",
          `Security ID is required for ${createDto.action} transactions`,
          { action: createDto.action },
        ),
      );
    }

    if (
      createDto.action === InvestmentAction.SPLIT &&
      (!createDto.quantity || Number(createDto.quantity) <= 0)
    ) {
      throw new BadRequestException(
        tr(
          "errors.securities.splitRatioRequired",
          "Split ratio (quantity) must be greater than zero",
        ),
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
      descriptionKey: "createdInvestmentTransaction",
      descriptionParams: { action: createDto.action },
    });

    return result;
  }

  /**
   * Create many investment transactions in one go for the "paste a table" bulk
   * approval flow. Best-effort: each row is created through the single-row
   * `create()` (its own QueryRunner, holdings/cash effects, action history) so a
   * row that fails -- a bad oversell, an unknown security -- is collected into
   * `skipped` rather than aborting the rest. Rows are processed in input order
   * so dependent rows (e.g. a BUY before a later SELL) compound correctly. The
   * expensive post-commit side effects `create()` triggers (net-worth recalc is
   * debounced; the SPLIT holdings rebuild is idempotent) collapse naturally
   * across the batch.
   */
  async createBulk(
    userId: string,
    dtos: CreateInvestmentTransactionDto[],
  ): Promise<BulkCreateResult<InvestmentTransaction>> {
    const created: InvestmentTransaction[] = [];
    const skipped: BulkCreateSkip[] = [];
    for (let index = 0; index < dtos.length; index++) {
      try {
        created.push(await this.create(userId, dtos[index]));
      } catch (error) {
        skipped.push({ index, reason: bulkSkipReason(error) });
        this.logger.warn(
          `Bulk investment row ${index} skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return { created, skipped };
  }

  /**
   * Validate and resolve a proposed investment transaction WITHOUT persisting
   * it. Used by the MCP `create_investment_transaction` dry-run/confirm path and
   * the AI Assistant confirmation flow so both surfaces validate, match the
   * security by symbol or name, and compute the cash impact identically.
   *
   * The security reference (`securityQuery`) is matched by ticker symbol or
   * name via `SecuritiesService.resolveBySymbolOrName`; an ambiguous or unknown
   * reference throws a 4xx the caller can surface. Action-specific requirements
   * mirror `create()` so the preview fails the same way the real write would.
   */
  async previewCreateInvestmentTransaction(
    userId: string,
    input: {
      accountId: string;
      action: InvestmentAction;
      transactionDate: string;
      securityQuery?: string;
      quantity?: number;
      price?: number;
      commission?: number;
      fundingAccountId?: string;
      description?: string;
    },
  ): Promise<CreateInvestmentTransactionPreview> {
    const account = await this.accountsService.findOne(userId, input.accountId);
    if (account.accountType !== "INVESTMENT") {
      throw new BadRequestException(
        tr(
          "errors.securities.accountMustBeInvestment",
          "Account must be of type INVESTMENT",
        ),
      );
    }

    // Match the security by symbol or name when a reference was supplied.
    let security: Security | null = null;
    if (input.securityQuery && input.securityQuery.trim()) {
      const resolved = await this.securitiesService.resolveBySymbolOrName(
        userId,
        input.securityQuery,
      );
      if (!resolved.match) {
        if (resolved.candidates.length > 0) {
          const list = resolved.candidates
            .map((c) => `${c.symbol} (${c.name})`)
            .join(", ");
          throw new BadRequestException(
            tr(
              "errors.securities.ambiguousSecurity",
              `"${input.securityQuery}" matches multiple securities: ${list}. Use the exact ticker symbol.`,
              { query: input.securityQuery, list },
            ),
          );
        }
        throw new BadRequestException(
          tr(
            "errors.securities.securityNotFoundByQuery",
            `No security matches "${input.securityQuery}". Add the security first or check the ticker symbol.`,
            { query: input.securityQuery },
          ),
        );
      }
      security = resolved.match;
    }

    // Mirror create()'s action-specific requirements so a preview rejected here
    // is exactly what the real write would reject.
    const securityRequiredActions: InvestmentAction[] = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.SPLIT,
      InvestmentAction.REINVEST,
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
    ];
    if (securityRequiredActions.includes(input.action) && !security) {
      throw new BadRequestException(
        tr(
          "errors.securities.securityIdRequired",
          `Security ID is required for ${input.action} transactions`,
          { action: input.action },
        ),
      );
    }
    if (
      input.action === InvestmentAction.SPLIT &&
      (!input.quantity || Number(input.quantity) <= 0)
    ) {
      throw new BadRequestException(
        tr(
          "errors.securities.splitRatioRequired",
          "Split ratio (quantity) must be greater than zero",
        ),
      );
    }

    let fundingAccount: Account | null = null;
    if (input.fundingAccountId) {
      fundingAccount = await this.accountsService.findOne(
        userId,
        input.fundingAccountId,
      );
    }

    // Round to each column's scale up front so the preview, the signed
    // descriptor, and the persisted row all carry identical values (and the
    // confirm-time DTO validation, which caps decimal places, never trips on a
    // value the user already approved).
    const quantity =
      input.quantity !== undefined && input.quantity !== null
        ? roundToDecimals(Number(input.quantity), 8)
        : null;
    const price =
      input.price !== undefined && input.price !== null
        ? roundToDecimals(Number(input.price), 6)
        : null;
    const commission = roundToDecimals(Number(input.commission ?? 0), 4);

    const totalAmount = this.calculateTotalAmount({
      action: input.action,
      quantity,
      price,
      commission,
    });

    const exchangeRate = await this.resolveCashExchangeRate(
      userId,
      input.accountId,
      input.fundingAccountId ?? null,
      security?.id ?? null,
      undefined,
    );

    // Signed cash impact in the security's currency, converted to the cash
    // account's currency for display. Zero for the share-only actions, which
    // create no linked cash transaction.
    const cashImpactSecurity = computeInvestmentCashImpact(
      input.action,
      Number(quantity ?? 0),
      Number(price ?? 0),
      commission,
    );

    let cashAccountName: string | null = null;
    let cashCurrency: string | null = null;
    let cashAmount: number | null = null;
    if (cashImpactSecurity !== 0) {
      const cashAccount =
        fundingAccount ?? (await this.findCashAccount(userId, input.accountId));
      const cashCurrencyEntity = await this.currenciesService.findOne(
        cashAccount.currencyCode,
      );
      cashAccountName = cashAccount.name;
      cashCurrency = cashAccount.currencyCode;
      cashAmount = roundToDecimals(
        cashImpactSecurity * exchangeRate,
        cashCurrencyEntity.decimalPlaces,
      );
    }

    return {
      accountId: account.id,
      accountName: account.name,
      accountCurrency: account.currencyCode,
      action: input.action,
      transactionDate: input.transactionDate,
      securityId: security?.id ?? null,
      symbol: security?.symbol ?? null,
      securityName: security?.name ?? null,
      securityCurrency: security?.currencyCode ?? null,
      quantity,
      price,
      commission,
      totalAmount,
      exchangeRate,
      fundingAccountId: fundingAccount?.id ?? null,
      cashAccountName,
      cashCurrency,
      cashAmount,
      description: stripHtml(input.description) || null,
    };
  }

  /**
   * Validate and resolve a proposed edit to an existing investment transaction
   * WITHOUT persisting it. Only the provided fields change; every other field
   * (account, action, date, security, quantity, price, commission, funding
   * account, description) is kept from the stored transaction. The resulting
   * state is run back through the same validation/total/cash computation as a
   * create so the preview equals what `update()` will persist.
   */
  async previewUpdateInvestmentTransaction(
    userId: string,
    transactionId: string,
    input: {
      action?: InvestmentAction;
      transactionDate?: string;
      securityQuery?: string;
      quantity?: number;
      price?: number;
      commission?: number;
      description?: string;
    },
  ): Promise<UpdateInvestmentTransactionPreview> {
    const existing = await this.findOne(userId, transactionId);

    const hasChange =
      input.action !== undefined ||
      input.transactionDate !== undefined ||
      input.securityQuery !== undefined ||
      input.quantity !== undefined ||
      input.price !== undefined ||
      input.commission !== undefined ||
      input.description !== undefined;
    if (!hasChange) {
      throw new BadRequestException(
        tr(
          "errors.securities.noUpdateFields",
          "Provide at least one field to change.",
        ),
      );
    }

    const preview = await this.previewCreateInvestmentTransaction(userId, {
      accountId: existing.accountId,
      action: input.action ?? existing.action,
      transactionDate: input.transactionDate ?? existing.transactionDate,
      securityQuery: input.securityQuery ?? existing.security?.symbol,
      quantity:
        input.quantity ??
        (existing.quantity !== null && existing.quantity !== undefined
          ? Number(existing.quantity)
          : undefined),
      price:
        input.price ??
        (existing.price !== null && existing.price !== undefined
          ? Number(existing.price)
          : undefined),
      commission: input.commission ?? Number(existing.commission ?? 0),
      fundingAccountId: existing.fundingAccountId ?? undefined,
      description: input.description ?? existing.description ?? undefined,
    });

    return { ...preview, transactionId };
  }

  /**
   * Validate ownership of an investment transaction the assistant proposes to
   * delete and return a display-only preview of what will be removed. The
   * actual deletion (including any linked transfer leg and cash impact) is
   * handled by `remove()`.
   */
  async previewDeleteInvestmentTransaction(
    userId: string,
    transactionId: string,
  ): Promise<DeleteInvestmentTransactionPreview> {
    const existing = await this.findOne(userId, transactionId);
    return {
      transactionId,
      accountName: existing.account?.name ?? "",
      action: existing.action,
      transactionDate: existing.transactionDate,
      symbol: existing.security?.symbol ?? null,
      securityName: existing.security?.name ?? null,
      securityCurrency: existing.security?.currencyCode ?? null,
      quantity:
        existing.quantity !== null && existing.quantity !== undefined
          ? Number(existing.quantity)
          : null,
      price:
        existing.price !== null && existing.price !== undefined
          ? Number(existing.price)
          : null,
      commission: Number(existing.commission ?? 0),
      totalAmount: Number(existing.totalAmount ?? 0),
      description: existing.description ?? null,
    };
  }

  /**
   * Map a resolved investment-transaction preview to the display row shown on a
   * bulk confirmation card. Inlined here (rather than reusing the builder's
   * `investmentPreviewRow`) to avoid a module cycle between this domain service
   * and `ai-action-builder.service`.
   */
  private toInvestmentPreviewRow(
    preview: CreateInvestmentTransactionPreview,
  ): AiActionPreviewRow {
    return {
      status: "ok",
      accountName: preview.accountName,
      investmentAction: preview.action,
      transactionDate: preview.transactionDate,
      symbol: preview.symbol,
      securityName: preview.securityName,
      securityCurrency: preview.securityCurrency,
      quantity: preview.quantity,
      price: preview.price,
      commission: preview.commission,
      totalAmount: preview.totalAmount,
      cashAccountName: preview.cashAccountName,
      cashCurrency: preview.cashCurrency,
      cashAmount: preview.cashAmount,
      description: preview.description,
    };
  }

  /** Pull a user-facing 4xx reason from a preview failure, else a fallback. */
  private investmentBulkSkipReason(err: unknown): string {
    if (
      err instanceof BadRequestException ||
      err instanceof NotFoundException
    ) {
      return err.message;
    }
    this.logger.warn(
      `investment bulk row preview failed: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return bulkSkipReason(err);
  }

  /**
   * Resolve + preview a single investment create row (NAMES resolved
   * internally), throwing on failure -- the single-card path. Shared by both
   * tool surfaces so they stay thin adapters.
   */
  async prepareCreateInvestmentSingle(
    userId: string,
    row: InvestmentCreateRowInput,
  ): Promise<CreateInvestmentTransactionPreview> {
    const resolved = await this.accountsService.resolveBrokerageByName(
      userId,
      row.accountName,
    );
    const account = resolved.match;
    if (!account) {
      if (resolved.candidates.length > 0) {
        const list = resolved.candidates.map((c) => c.name).join(", ");
        throw new BadRequestException(
          tr(
            "errors.accounts.ambiguousBrokerage",
            `"${row.accountName}" matches multiple brokerage accounts: ${list}. Use the exact account name.`,
            { query: row.accountName, list },
          ),
        );
      }
      throw new NotFoundException(
        tr(
          "errors.accounts.unknownInvestmentAccount",
          `Unknown account: ${row.accountName}. Use an exact name from the user's account list.`,
          { name: row.accountName },
        ),
      );
    }
    let fundingAccountId: string | undefined;
    if (row.fundingAccountName) {
      const funding = await this.accountsService.resolveByName(
        userId,
        row.fundingAccountName,
      );
      if (!funding) {
        throw new NotFoundException(
          `Unknown funding account: ${row.fundingAccountName}. Use an exact name from the user's account list.`,
        );
      }
      fundingAccountId = funding.id;
    }
    return this.previewCreateInvestmentTransaction(userId, {
      accountId: account.id,
      action: row.action,
      transactionDate: row.date,
      securityQuery: row.securityQuery,
      quantity: row.quantity,
      price: row.price,
      commission: row.commission,
      fundingAccountId,
      description: row.description,
    });
  }

  /**
   * Resolve + preview each investment create row best-effort: rows that fail to
   * resolve (unknown account/security) or validate are collected into `skipped`
   * and flagged in `previewRows` rather than aborting the batch. Mirrors the
   * cash `TransactionToolPrepService.prepareCreate`.
   */
  async prepareCreateInvestmentBulk(
    userId: string,
    rows: InvestmentCreateRowInput[],
  ): Promise<PrepareInvestmentCreateBulkResult> {
    const okPreviews: CreateInvestmentTransactionPreview[] = [];
    const okIndex: number[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const base: AiActionPreviewRow = {
        status: "error",
        accountName: row.accountName,
        investmentAction: row.action,
        transactionDate: row.date,
        symbol: row.securityQuery ?? null,
        quantity: row.quantity ?? null,
        price: row.price ?? null,
        commission: row.commission ?? 0,
        description: row.description ?? null,
      };

      const resolved = await this.accountsService.resolveBrokerageByName(
        userId,
        row.accountName,
      );
      const account = resolved.match;
      if (!account) {
        const reason =
          resolved.candidates.length > 0
            ? `Ambiguous account: "${row.accountName}" matches ${resolved.candidates
                .map((c) => c.name)
                .join(", ")}`
            : `Unknown account: ${row.accountName}`;
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
        continue;
      }

      let fundingAccountId: string | undefined;
      if (row.fundingAccountName) {
        const funding = await this.accountsService.resolveByName(
          userId,
          row.fundingAccountName,
        );
        if (!funding) {
          const reason = `Unknown funding account: ${row.fundingAccountName}`;
          skipped.push({ index: i, reason });
          previewRows.push({ ...base, error: reason });
          continue;
        }
        fundingAccountId = funding.id;
      }

      try {
        const preview = await this.previewCreateInvestmentTransaction(userId, {
          accountId: account.id,
          action: row.action,
          transactionDate: row.date,
          securityQuery: row.securityQuery,
          quantity: row.quantity,
          price: row.price,
          commission: row.commission,
          fundingAccountId,
          description: row.description,
        });
        okPreviews.push(preview);
        okIndex.push(i);
        previewRows.push(this.toInvestmentPreviewRow(preview));
      } catch (err) {
        const reason = this.investmentBulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ ...base, error: reason });
      }
    }

    return { okPreviews, okIndex, previewRows, skipped };
  }

  /**
   * Resolve + preview each investment edit best-effort, mapping the resulting
   * resolved state to a `BatchUpdateInvestmentTransactionRow` and a display row.
   * Mirrors the cash `TransactionToolPrepService.prepareUpdateBulk`.
   */
  async prepareUpdateInvestmentBulk(
    userId: string,
    rows: InvestmentUpdateRowInput[],
  ): Promise<PrepareInvestmentUpdateBulkResult> {
    const okRows: BatchUpdateInvestmentTransactionRow[] = [];
    const okIndex: number[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const preview = await this.previewUpdateInvestmentTransaction(
          userId,
          row.transactionId,
          {
            action: row.action,
            transactionDate: row.date,
            securityQuery: row.securityQuery,
            quantity: row.quantity,
            price: row.price,
            commission: row.commission,
            description: row.description,
          },
        );
        okRows.push({
          transactionId: preview.transactionId,
          accountId: preview.accountId,
          action: preview.action,
          transactionDate: preview.transactionDate,
          securityId: preview.securityId,
          fundingAccountId: preview.fundingAccountId,
          quantity: preview.quantity,
          price: preview.price,
          commission: preview.commission,
          exchangeRate: preview.exchangeRate,
          description: preview.description,
        });
        okIndex.push(i);
        previewRows.push(this.toInvestmentPreviewRow(preview));
      } catch (err) {
        const reason = this.investmentBulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({
          status: "error",
          transactionDate: row.date ?? undefined,
          symbol: row.securityQuery ?? null,
          error: reason,
        });
      }
    }

    return { okRows, okIndex, previewRows, skipped };
  }

  /**
   * Preview each investment deletion best-effort, mapping to a batch delete row
   * and a display row. Mirrors `TransactionToolPrepService.prepareDeleteBulk`.
   */
  async prepareDeleteInvestmentBulk(
    userId: string,
    transactionIds: string[],
  ): Promise<PrepareInvestmentDeleteBulkResult> {
    const okRows: BatchDeleteInvestmentTransactionRow[] = [];
    const okIndex: number[] = [];
    const previewRows: AiActionPreviewRow[] = [];
    const skipped: BulkCreateSkip[] = [];

    for (let i = 0; i < transactionIds.length; i++) {
      const transactionId = transactionIds[i];
      try {
        const preview = await this.previewDeleteInvestmentTransaction(
          userId,
          transactionId,
        );
        okRows.push({ transactionId });
        okIndex.push(i);
        previewRows.push({
          status: "ok",
          accountName: preview.accountName,
          investmentAction: preview.action,
          transactionDate: preview.transactionDate,
          symbol: preview.symbol,
          securityName: preview.securityName,
          securityCurrency: preview.securityCurrency,
          quantity: preview.quantity,
          price: preview.price,
          commission: preview.commission,
          totalAmount: preview.totalAmount,
          description: preview.description,
        });
      } catch (err) {
        const reason = this.investmentBulkSkipReason(err);
        skipped.push({ index: i, reason });
        previewRows.push({ status: "error", error: reason });
      }
    }

    return { okRows, okIndex, previewRows, skipped };
  }

  /**
   * Reject investment accounts that don't track holdings. Securities can only
   * live in brokerage / standalone investment accounts (null subtype); the cash
   * sleeve (INVESTMENT_CASH) is excluded from every holdings rebuild and
   * negative-balance guard, so transferring shares into it would leave them
   * absent from the ledger while still drawing down the source.
   */
  private assertCanHoldSecurities(account: Account, label: string): void {
    if (
      account.accountSubType &&
      account.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE
    ) {
      throw new BadRequestException(
        tr(
          "errors.securities.cannotHoldSecurities",
          `${label} cannot hold securities`,
          { label },
        ),
      );
    }
  }

  /**
   * Move a security between two investment accounts while preserving cost
   * basis. Creates both legs atomically: a TRANSFER_OUT in the source account
   * (drawn down at the source's running average cost) and a TRANSFER_IN in the
   * destination account at the source's carried average cost. No cash
   * transaction is created -- shares move only, no money changes hands -- so
   * both legs use exchangeRate 1 and have a null linked cash transaction.
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
        tr(
          "errors.securities.sourceDestMustDiffer",
          "Source and destination accounts must be different",
        ),
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
      throw new BadRequestException(
        tr(
          "errors.securities.bothAccountsMustBeInvestment",
          "Both accounts must be of type INVESTMENT",
        ),
      );
    }

    // Securities only live in brokerage / standalone investment accounts. The
    // cash sleeve of an investment account is excluded from every holdings
    // rebuild, so shares transferred into it would silently vanish.
    this.assertCanHoldSecurities(fromAccount, "Source account");
    this.assertCanHoldSecurities(toAccount, "Destination account");

    if (toAccount.isClosed) {
      throw new BadRequestException(
        tr(
          "errors.securities.destinationAccountClosed",
          "Destination account is closed",
        ),
      );
    }

    await this.securitiesService.findOne(userId, dto.securityId);

    // Carry the source's actual blended average cost so basis is conserved.
    // The client sends a prefilled costPerShare for display, but the server is
    // authoritative here: a stale or zero client value (e.g. a UI race before
    // holdings load, or a direct API call) must not be able to poison the
    // destination's cost basis. When the source holds the security, its current
    // average cost is exactly what the TRANSFER_OUT draws down, so using it for
    // both legs conserves basis. With no existing holding the over-draw guard
    // below rejects the transfer anyway, so the client value is a harmless
    // fallback.
    const sourceHolding = await this.holdingsService.findByAccountAndSecurity(
      dto.fromAccountId,
      dto.securityId,
    );
    const carriedCost =
      sourceHolding && Number(sourceHolding.quantity) > 0
        ? roundToDecimals(Number(sourceHolding.averageCost) || 0, 6)
        : dto.costPerShare;

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
        price: carriedCost,
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
        price: carriedCost,
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

      // Link the two legs to each other so a later edit or delete of one
      // cascades to its pair.
      await queryRunner.manager.update(InvestmentTransaction, outId, {
        linkedTransactionId: inId,
      });
      await queryRunner.manager.update(InvestmentTransaction, inId, {
        linkedTransactionId: outId,
      });

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
      // Flat leg + linkedTransferLeg shape mirrors the delete beforeData so the
      // redo path (which feeds afterData into undoInvestmentDelete) restores
      // both legs and their mutual link.
      afterData: { ...transferOut, linkedTransferLeg: { ...transferIn } },
      description: "Transferred security between accounts",
      descriptionKey: "transferredSecurity",
    });

    return { transferOut, transferIn };
  }

  private calculateTotalAmount(dto: {
    action: InvestmentAction;
    quantity?: number | null;
    price?: number | null;
    commission?: number | null;
  }): number {
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

    // M13: Round to money storage precision (4dp) to avoid floating-point drift
    return roundMoney(result);
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
        // A reinvestment buys shares at a market price; without a price the
        // shares would be blended in at cost 0 and poison the average cost, so
        // keep the price guard here. Only TRANSFER_IN/OUT (whose carried cost
        // can legitimately be 0) drop it.
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
        if (!isFuture && securityId && quantity) {
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
        if (!isFuture && securityId && quantity) {
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
        tr(
          "errors.securities.actionNotAllowedInSplit",
          `Investment action ${dto.action} is not allowed inside a split transaction`,
          { action: dto.action },
        ),
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
        tr(
          "errors.securities.embeddedSplitRequiresBrokerage",
          "Embedded investment splits require an INVESTMENT_BROKERAGE account",
        ),
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
        tr(
          "errors.securities.securityIdRequired",
          `Security ID is required for ${dto.action} transactions`,
          { action: dto.action },
        ),
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
    const newSplitAmount = roundMoney(
      cashImpactInSecurity * Number(saved.exchangeRate),
    );

    const split = await queryRunner.manager.findOne(TransactionSplit, {
      where: { id: splitId },
    });
    if (!split) {
      throw new NotFoundException(
        tr(
          "errors.securities.transactionSplitNotFound",
          `Transaction split ${splitId} not found for embedded investment update`,
          { splitId },
        ),
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
        tr(
          "errors.securities.parentTransactionNotFound",
          `Parent transaction ${split.transactionId} not found for embedded investment update`,
          { transactionId: split.transactionId },
        ),
      );
    }

    const siblingSplits = await queryRunner.manager.find(TransactionSplit, {
      where: { transactionId: split.transactionId },
    });
    const newParentAmount = sumMoney(
      siblingSplits.map((s) =>
        s.id === splitId ? newSplitAmount : Number(s.amount),
      ),
    );
    const oldParentAmount = Number(parentTransaction.amount);
    const delta = roundMoney(newParentAmount - oldParentAmount);

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
  ): Promise<PaginatedResult<InvestmentTransaction>> {
    const {
      page: pageNum,
      limit: pageSize,
      skip,
    } = clampPagination(page, limit);

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
      .skip(skip)
      .take(pageSize)
      .getMany();

    return {
      data,
      pagination: buildPaginationMeta(pageNum, pageSize, total),
    };
  }

  /**
   * Apply a transaction's effect on a running share balance. Mirrors the
   * authoritative per-action math in HoldingsService.getHoldingAt so the
   * running totals reconcile with stored holdings.
   */
  private applyQuantityToBalance(
    balance: number,
    action: InvestmentAction,
    quantity: number,
  ): number {
    switch (action) {
      case InvestmentAction.BUY:
      case InvestmentAction.REINVEST:
      case InvestmentAction.TRANSFER_IN:
      case InvestmentAction.ADD_SHARES:
        return balance + quantity;
      case InvestmentAction.SELL:
      case InvestmentAction.TRANSFER_OUT:
      case InvestmentAction.REMOVE_SHARES:
        return balance - quantity;
      case InvestmentAction.SPLIT:
        return quantity > 0 ? balance * quantity : balance;
      default:
        // DIVIDEND / INTEREST / CAPITAL_GAIN do not move shares.
        return balance;
    }
  }

  /**
   * Full transaction history for a single security with a running share
   * balance after each transaction -- both within the transaction's own
   * account and across all accounts the security is held in. Also returns the
   * list of accounts the security was ever transacted in (including closed
   * accounts) with their exact current share balance.
   *
   * Quantities are intentionally NOT snapped to zero, so tiny residual
   * positions remain visible -- this view exists to track them down.
   */
  async getSecurityTransactionHistory(
    userId: string,
    securityId: string,
  ): Promise<SecurityTransactionHistory> {
    // Validates ownership and existence (works for inactive securities too).
    const security = await this.securitiesService.findOne(userId, securityId);

    const transactions = await this.investmentTransactionsRepository.find({
      where: { userId, securityId },
      relations: ["account"],
      order: { transactionDate: "ASC", createdAt: "ASC" },
    });

    const balances = new Map<string, number>();
    const accountMeta = new Map<string, { name: string; isClosed: boolean }>();
    let runningAll = 0;

    const rows: SecurityHistoryTransaction[] = transactions.map((tx) => {
      const accountId = tx.accountId;
      if (!accountMeta.has(accountId)) {
        accountMeta.set(accountId, {
          name: tx.account?.name ?? "Unknown account",
          isClosed: tx.account?.isClosed ?? false,
        });
      }

      const prevBalance = balances.get(accountId) ?? 0;
      const newBalance = this.applyQuantityToBalance(
        prevBalance,
        tx.action,
        Number(tx.quantity) || 0,
      );
      balances.set(accountId, newBalance);
      // Delta keeps the cross-account total correct even for SPLIT, which
      // multiplies a single account's balance rather than adding to it.
      runningAll += newBalance - prevBalance;

      return {
        id: tx.id,
        transactionDate: tx.transactionDate,
        accountId,
        accountName: accountMeta.get(accountId)!.name,
        action: tx.action,
        quantity: tx.quantity === null ? null : Number(tx.quantity),
        price: tx.price === null ? null : Number(tx.price),
        commission: Number(tx.commission) || 0,
        totalAmount: Number(tx.totalAmount) || 0,
        description: tx.description,
        runningQuantityAccount: newBalance,
        runningQuantityAll: runningAll,
      };
    });

    const accounts: SecurityHistoryAccount[] = Array.from(accountMeta.entries())
      .map(([accountId, meta]) => ({
        accountId,
        accountName: meta.name,
        isClosed: meta.isClosed,
        currentQuantity: balances.get(accountId) ?? 0,
      }))
      .sort((a, b) => a.accountName.localeCompare(b.accountName));

    return {
      securityId,
      symbol: security.symbol,
      name: security.name,
      currencyCode: security.currencyCode,
      isActive: security.isActive,
      accounts,
      transactions: rows,
      currentQuantityAll: runningAll,
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
        startValue: roundMoney(b.startValueScaled / 10000),
        endValue: roundMoney(b.endValueScaled / 10000),
        realizedGain: roundMoney(b.realizedScaled / 10000),
        unrealizedGain: roundMoney(b.unrealizedScaled / 10000),
        totalCapitalGain: roundMoney(b.totalScaled / 10000),
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
        realizedGain: roundMoney(totalsRealizedScaled / 10000),
        unrealizedGain: roundMoney(totalsUnrealizedScaled / 10000),
        totalCapitalGain: roundMoney(totalsCapitalScaled / 10000),
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
        tr(
          "errors.securities.investmentTransactionNotFound",
          `Investment transaction with ID ${id} not found`,
          { id },
        ),
      );
    }

    return transaction;
  }

  /**
   * Edit one leg of a linked security transfer and keep its pair consistent.
   * The edited leg may change its own account; the security, quantity,
   * per-share cost, date and description are shared and propagated to both
   * legs so the cost basis stays balanced across the move. The transfer's
   * direction (which leg is IN vs OUT) cannot be changed here.
   */
  private async updateLinkedTransfer(
    userId: string,
    editedLeg: InvestmentTransaction,
    linkedLeg: InvestmentTransaction,
    updateDto: UpdateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    if (
      updateDto.action !== undefined &&
      updateDto.action !== editedLeg.action
    ) {
      throw new BadRequestException(
        tr(
          "errors.securities.cannotChangeTransferDirection",
          "Cannot change the direction of a transfer; delete it and create a new transfer instead",
        ),
      );
    }

    const beforeData = { ...editedLeg };
    const beforeLinked = { ...linkedLeg };
    const editedLegId = editedLeg.id;

    // Track every (account, security) the edit could touch -- old and new on
    // both legs -- so the negative-holdings guard is scoped correctly.
    const affectedAccountIds = new Set<string>([
      editedLeg.accountId,
      linkedLeg.accountId,
    ]);
    const affectedSecurityIds = new Set<string>();
    if (editedLeg.securityId) affectedSecurityIds.add(editedLeg.securityId);

    if (updateDto.securityId !== undefined && updateDto.securityId) {
      await this.securitiesService.findOne(userId, updateDto.securityId);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Reverse both legs at their original values before reapplying.
      await this.reverseTransactionEffectsInTransaction(
        queryRunner,
        userId,
        editedLeg,
      );
      await this.reverseTransactionEffectsInTransaction(
        queryRunner,
        userId,
        linkedLeg,
      );

      // Resolve legs by role, not by which leg id was passed in: `accountId`
      // is always the source (TRANSFER_OUT) account and `destinationAccountId`
      // the destination (TRANSFER_IN) account. Mapping by role keeps the
      // direction correct even when the IN leg is edited directly.
      const outLeg =
        editedLeg.action === InvestmentAction.TRANSFER_OUT
          ? editedLeg
          : linkedLeg;
      const inLeg =
        editedLeg.action === InvestmentAction.TRANSFER_IN
          ? editedLeg
          : linkedLeg;

      // The source leg may move to a different account.
      if (updateDto.accountId !== undefined) {
        const account = await this.accountsService.findOne(
          userId,
          updateDto.accountId,
        );
        if (account.accountType !== "INVESTMENT") {
          throw new BadRequestException(
            tr(
              "errors.securities.accountMustBeInvestment",
              "Account must be of type INVESTMENT",
            ),
          );
        }
        this.assertCanHoldSecurities(account, "Account");
        outLeg.accountId = updateDto.accountId;
        outLeg.account = { id: updateDto.accountId } as any;
      }

      // The destination leg can be rerouted to a different account.
      if (updateDto.destinationAccountId !== undefined) {
        const destAccount = await this.accountsService.findOne(
          userId,
          updateDto.destinationAccountId,
        );
        if (destAccount.accountType !== "INVESTMENT") {
          throw new BadRequestException(
            tr(
              "errors.securities.destinationAccountMustBeInvestment",
              "Destination account must be of type INVESTMENT",
            ),
          );
        }
        if (destAccount.isClosed) {
          throw new BadRequestException(
            tr(
              "errors.securities.destinationAccountClosed",
              "Destination account is closed",
            ),
          );
        }
        this.assertCanHoldSecurities(destAccount, "Destination account");
        inLeg.accountId = updateDto.destinationAccountId;
        inLeg.account = { id: updateDto.destinationAccountId } as any;
      }

      if (outLeg.accountId === inLeg.accountId) {
        throw new BadRequestException(
          tr(
            "errors.securities.sourceDestMustDiffer",
            "Source and destination accounts must be different",
          ),
        );
      }

      // Shared fields applied to both legs.
      const applyShared = (leg: InvestmentTransaction) => {
        if (updateDto.securityId !== undefined) {
          leg.securityId = updateDto.securityId || null;
          leg.security = updateDto.securityId
            ? ({ id: updateDto.securityId } as any)
            : (null as any);
        }
        if (updateDto.quantity !== undefined) leg.quantity = updateDto.quantity;
        if (updateDto.price !== undefined) leg.price = updateDto.price;
        if (updateDto.commission !== undefined)
          leg.commission = updateDto.commission;
        if (updateDto.transactionDate !== undefined)
          leg.transactionDate = updateDto.transactionDate;
        if (updateDto.description !== undefined)
          leg.description = updateDto.description;
        // Transfers carry no cash.
        leg.totalAmount = 0;
        leg.exchangeRate = 1;
      };
      applyShared(editedLeg);
      applyShared(linkedLeg);

      affectedAccountIds.add(editedLeg.accountId);
      affectedAccountIds.add(linkedLeg.accountId);
      if (editedLeg.securityId) affectedSecurityIds.add(editedLeg.securityId);

      const savedEdited = await queryRunner.manager.save(editedLeg);
      const savedLinked = await queryRunner.manager.save(linkedLeg);

      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        savedEdited,
        true,
        false,
      );
      await this.processTransactionEffectsInTransaction(
        queryRunner,
        userId,
        savedLinked,
        true,
        false,
      );

      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        queryRunner,
        Array.from(affectedAccountIds),
        affectedSecurityIds.size > 0
          ? Array.from(affectedSecurityIds)
          : undefined,
      );

      // The incremental reverse/re-apply above can misattribute average cost
      // when a leg crosses a zero balance (a TRANSFER_OUT reversal re-establishes
      // the source's cost basis from the leg's price instead of the source's
      // true blended cost). Rebuild the affected accounts from the authoritative
      // transaction history inside this transaction so both accounts' share
      // counts and average cost are exact -- and so a rebuild failure rolls the
      // whole edit back rather than silently committing wrong holdings.
      await this.holdingsService.rebuildAccountsFromTransactions(
        userId,
        Array.from(affectedAccountIds),
        queryRunner,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    for (const accId of affectedAccountIds) {
      this.triggerRecalcWithCashAccount(accId, userId);
    }

    const result = await this.findOne(userId, editedLegId);
    const linkedResult = await this.findOne(userId, linkedLeg.id);

    this.actionHistoryService.record(userId, {
      entityType: "investment_transaction",
      entityId: editedLegId,
      // beforeData and afterData both carry the paired leg under
      // linkedTransferLeg so undo (beforeData) and redo (afterData) can restore
      // both legs symmetrically.
      action: "update",
      beforeData: { ...beforeData, linkedTransferLeg: beforeLinked },
      afterData: { ...result, linkedTransferLeg: { ...linkedResult } },
      description: "Updated security transfer",
      descriptionKey: "updatedSecurityTransfer",
    });

    return result;
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    const transaction = await this.findOne(userId, id);

    // A security transfer is two linked legs. Editing one keeps the pair in
    // sync (shared security/quantity/cost/date) so cost basis stays balanced.
    if (
      transaction.linkedTransactionId &&
      (transaction.action === InvestmentAction.TRANSFER_IN ||
        transaction.action === InvestmentAction.TRANSFER_OUT)
    ) {
      const linkedLeg = await this.investmentTransactionsRepository.findOne({
        where: { id: transaction.linkedTransactionId, userId },
      });
      if (!linkedLeg) {
        // The pair is missing (stale link / partial data). Editing this leg
        // alone would leave the two legs unbalanced, so refuse rather than
        // silently corrupting the transfer.
        throw new ConflictException(
          tr(
            "errors.securities.transferPairMissing",
            "This transfer's paired transaction is missing; delete and recreate the transfer instead of editing it",
          ),
        );
      }
      return this.updateLinkedTransfer(
        userId,
        transaction,
        linkedLeg,
        updateDto,
      );
    }

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
          tr(
            "errors.securities.cannotChangeSplitAccount",
            "Cannot change the account of an investment split; remove the split and add it on the new account instead",
          ),
        );
      }
      if (
        updateDto.fundingAccountId !== undefined &&
        (updateDto.fundingAccountId || null) !== transaction.fundingAccountId
      ) {
        throw new BadRequestException(
          tr(
            "errors.securities.splitNoFundingAccount",
            "Investment splits do not use a separate funding account",
          ),
        );
      }
      if (
        updateDto.transactionDate !== undefined &&
        updateDto.transactionDate !== transaction.transactionDate
      ) {
        throw new BadRequestException(
          tr(
            "errors.securities.cannotChangeSplitDate",
            "Cannot change the date of an investment split; edit the parent split transaction date instead",
          ),
        );
      }
      const effectiveAction = updateDto.action ?? transaction.action;
      if (!isInvestmentActionAllowedInSplit(effectiveAction)) {
        throw new BadRequestException(
          tr(
            "errors.securities.actionNotAllowedInSplit",
            `Investment action ${effectiveAction} is not allowed inside a split transaction`,
            { action: effectiveAction },
          ),
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
            tr(
              "errors.securities.securityIdRequired",
              `Security ID is required for ${updateDto.action} transactions`,
              { action: updateDto.action },
            ),
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
        });
      }

      if (
        transaction.action === InvestmentAction.SPLIT &&
        (transaction.quantity === null ||
          transaction.quantity === undefined ||
          Number(transaction.quantity) <= 0)
      ) {
        throw new BadRequestException(
          tr(
            "errors.securities.splitRatioRequired",
            "Split ratio (quantity) must be greater than zero",
          ),
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
      descriptionKey: "updatedInvestmentTransaction",
      descriptionParams: { action: result.action },
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

    // A security transfer is two linked legs (TRANSFER_OUT <-> TRANSFER_IN).
    // Deleting either one removes the whole transfer so holdings can't be
    // left half-moved.
    const linkedLeg = transaction.linkedTransactionId
      ? await this.investmentTransactionsRepository.findOne({
          where: { id: transaction.linkedTransactionId, userId },
        })
      : null;
    if (linkedLeg) {
      beforeData.linkedTransferLeg = { ...linkedLeg };
    }

    const legsToRemove = linkedLeg ? [transaction, linkedLeg] : [transaction];
    const affectedAccountIds = Array.from(
      new Set(legsToRemove.map((leg) => leg.accountId)),
    );
    const affectedSecurityIds = Array.from(
      new Set(
        legsToRemove
          .map((leg) => leg.securityId)
          .filter((sid): sid is string => Boolean(sid)),
      ),
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Break the mutual link before deleting so neither row's FK points at a
      // row that is about to disappear.
      for (const leg of legsToRemove) {
        if (leg.linkedTransactionId) {
          await queryRunner.manager.update(InvestmentTransaction, leg.id, {
            linkedTransactionId: null,
          });
          leg.linkedTransactionId = null;
        }
      }

      for (const leg of legsToRemove) {
        await this.reverseTransactionEffectsInTransaction(
          queryRunner,
          userId,
          leg,
        );
        await queryRunner.manager.remove(leg);
      }

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

    if (transaction.action === InvestmentAction.SPLIT) {
      await this.holdingsService
        .rebuildFromTransactions(userId)
        .catch((err) =>
          this.logger.warn(
            `Holdings rebuild after SPLIT remove failed: ${err.message}`,
          ),
        );
    }

    for (const accId of affectedAccountIds) {
      this.triggerRecalcWithCashAccount(accId, userId);
    }
    if (transaction.fundingAccountId) {
      this.triggerRecalcWithCashAccount(
        accountId,
        userId,
        transaction.fundingAccountId,
      );
    }

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
      descriptionKey: "deletedInvestmentTransaction",
      descriptionParams: { action: beforeData.action },
    });
  }

  /**
   * Compact investment-transaction query for LLM / AI consumers. Called by
   * both the AI Assistant's tool executor and the MCP server's
   * `list_investment_transactions` tool so the two surfaces return the same
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

    // round4 here is reserved for per-share prices (4dp price precision);
    // monetary amounts use the shared roundMoney, quantities use round8 (1e-8).
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
        commission: roundMoney(Number(r.commission || 0)),
        totalAmount: roundMoney(Number(r.totalAmount)),
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
          totalAmount: roundMoney(b.amountScaled / 10000),
          totalCommission: roundMoney(b.commissionScaled / 10000),
        }))
        .sort((a, b) =>
          options.groupBy === "date"
            ? b.key.localeCompare(a.key)
            : b.totalAmount - a.totalAmount,
        );
    }

    return {
      transactionCount: rows.length,
      totalAmount: roundMoney(totalAmountScaled / 10000),
      totalCommission: roundMoney(totalCommissionScaled / 10000),
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
      totalDividends: sumMoney(
        transactions
          .filter((t) => t.action === InvestmentAction.DIVIDEND)
          .map((t) => Number(t.totalAmount)),
      ),
      totalInterest: sumMoney(
        transactions
          .filter((t) => t.action === InvestmentAction.INTEREST)
          .map((t) => Number(t.totalAmount)),
      ),
      totalCapitalGains: sumMoney(
        transactions
          .filter((t) => t.action === InvestmentAction.CAPITAL_GAIN)
          .map((t) => Number(t.totalAmount)),
      ),
      totalCommissions: sumMoney(
        transactions.map((t) => Number(t.commission || 0)),
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
