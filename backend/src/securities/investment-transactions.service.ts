import { accrualErrors } from "../accruals/accrual-errors";
import {
  HttpException,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import {
  beginBondWriteGuard,
  BondWriteGuard,
  createBondWriteGuard,
} from "../bonds/bond-write-guard";
import {
  programOfSecurity,
  resolveTransactionSeries,
  seriesCodeOf,
} from "../bonds/bond-series-resolver";
import { BondHoldingsService } from "../bonds/bond-holdings.service";
import {
  applyRedemptionSplit,
  FilledRedemption,
} from "./bond-redemption-fill.util";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager } from "typeorm";
import { getActiveScopedManager, withScopedDb } from "../common/db/scoped-db";
import {
  lockTransactionRow,
  lockTransactionRows,
  lockInvestmentTransactionRow,
  lockHoldingScope,
  LockedInvestmentTransactionRow,
} from "../common/db/locks";
import { lockUnchangedInvestmentRow } from "./investment-row-lock.util";
import { applyVoidTransitionToMirrorLeg } from "../transactions/void-status-transition.util";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { investmentRowHasEffect } from "./investment-row-effects.util";
import { formatInvestmentCashPayeeName } from "./investment-cash-payee.util";
import { attachInvestmentRowCurrencies } from "./investment-transaction-currencies.util";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Security } from "./entities/security.entity";
import {
  applyActionToQuantity,
  baseInvestmentAction,
  incomeKind,
  INVESTMENT_REPLAY_ORDER,
  investmentIncomeAmount,
} from "./investment-replay.util";
import {
  disposalCashAmount,
  isAccruedInterestCompanion,
  supportsAccruedInterest,
} from "./accrued-interest.util";
import { CreateInvestmentTransactionDto } from "./dto/create-investment-transaction.dto";
import { UpdateInvestmentTransactionDto } from "./dto/update-investment-transaction.dto";
import { TransferSecurityDto } from "./dto/transfer-security.dto";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { HoldingsService, HoldingScope } from "./holdings.service";
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
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture, todayYMD } from "../common/date-utils";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  computeInvestmentCashImpact,
  investmentSplitCashAmount,
  isInvestmentActionAllowedInSplit,
} from "./cash-impact.util";
import {
  INVESTMENT_PRICE_DECIMALS,
  deriveInvestmentTotal,
  resolveInvestmentAmounts,
} from "./investment-amount.util";
import {
  AiActionPreviewRow,
  BatchUpdateInvestmentTransactionRow,
  BatchDeleteInvestmentTransactionRow,
  BondRedemptionSplitPreview,
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
  /**
   * `null` when any row folded into this entry had an unknown boundary value --
   * a security whose currency could not be converted into its account's. An
   * unknown component makes the sum unknown; the partial sum is not returned
   * under a field a caller would read as complete
   * (docs/financial-calculation-contract.md section 1). `realizedGain` is
   * `null` when a folded row's realized gain rests on a basis carrying an
   * unpriced acquisition -- a gain against an unknown basis is unknown.
   */
  startValue: number | null;
  endValue: number | null;
  realizedGain: number | null;
  /** False when `realizedGain` is null for want of a basis. Read as `=== false`. */
  realizedGainComplete: boolean;
  /** The gains that are known, when `realizedGainComplete` is false; otherwise null. */
  realizedGainKnownSubtotal: number | null;
  unrealizedGain: number | null;
  totalCapitalGain: number | null;
}

export interface LlmCapitalGainsResult {
  startDate: string;
  endDate: string;
  totals: {
    /** `null` when any row's realized gain rests on an unknown basis. */
    realizedGain: number | null;
    realizedGainComplete: boolean;
    /** The gains that are known, when `realizedGainComplete` is false; otherwise null. */
    realizedGainKnownSubtotal: number | null;
    /**
     * `null` when any row in the window had an unconvertible boundary value.
     * A total that silently omitted those rows would read as complete.
     */
    unrealizedGain: number | null;
    totalCapitalGain: number | null;
  };
  groupedBy: LlmCapitalGainsGroupBy;
  entries: LlmCapitalGainsEntry[];
  entryCount: number;
  truncatedEntryList: boolean;
}

/** The currency a row's income is in: the security's, else the account's. */
function llmIncomeCurrency(row: InvestmentTransaction): string | null {
  return row.security?.currencyCode ?? row.account?.currencyCode ?? null;
}

/** Adds a row's income, in ten-thousandths, under the currency it is in. */
function addIncomeScaled(
  byCurrency: Map<string, number>,
  row: InvestmentTransaction,
): void {
  const scaled = Math.round(investmentIncomeAmount(row) * 10000);
  if (scaled === 0) return;
  const currency = llmIncomeCurrency(row) ?? "";
  byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + scaled);
}

function incomeByCurrencyOf(
  scaledByCurrency: Map<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    [...scaledByCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, scaled]) => [currency, roundMoney(scaled / 10000)]),
  );
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
  /**
   * The dividend, interest or capital-gain distribution this row records, paid
   * in cash or reinvested in shares; 0 for a row that records none. A reinvest
   * created in the app stores no total, so this is where its distribution shows.
   */
  incomeAmount: number;
  /** The currency `incomeAmount` is in: the security's, else the account's. */
  incomeCurrency: string | null;
  currency: string | null;
  description: string | null;
  /**
   * A VOID row is listed so the model can see the record exists, but it moved
   * no money or shares and is excluded from every total and group sum.
   */
  status: string;
}

export interface LlmInvestmentTxGroup {
  key: string;
  transactionCount: number;
  totalQuantity: number;
  totalAmount: number;
  totalCommission: number;
  /** The rows' `incomeAmount`, summed per `incomeCurrency`. */
  incomeByCurrency: Record<string, number>;
}

export interface LlmInvestmentTransactionsResult {
  transactionCount: number;
  totalAmount: number;
  totalCommission: number;
  /**
   * Dividends, interest and capital-gain distributions, cash and reinvested,
   * summed per currency they are in. Never added across currencies: nothing
   * here is converted, so a single figure would be in no currency at all.
   */
  incomeByCurrency: Record<string, number>;
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
  /** A VOID row is listed but moved no shares; the running balances skip it. */
  status: TransactionStatus;
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
  /** Accrued interest riding on the same cash movement (REDEEM only). */
  accruedInterest: number;
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
  /**
   * The bond series of a program-linked security as it will be stored
   * (INV-BOND-007): the one given, or inferred from the date; null otherwise.
   */
  bondInstrumentId: string | null;
  /** Its code (`EDO1036`), for the confirmation card. */
  bondSeriesCode: string | null;
  /**
   * REDEEM of a bond-linked security: what the redemption pays, split into
   * principal and interest, and where the row's price and accrued interest came
   * from (INV-BOND-009). Null for any other row, or when the caller stated both
   * figures and the split could not be worked out.
   */
  redemptionSplit: BondRedemptionSplitPreview | null;
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
  /** REDEEM only; recorded as the linked INTEREST companion. */
  accruedInterest?: number;
  fundingAccountName?: string;
  /** Optional FX rate (security currency -> cash currency) to pin the cash posting. */
  exchangeRate?: number;
  description?: string;
  /** The bond series of a program-linked security: its code (`EDO1036`) or id. */
  bondSeriesCode?: string;
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
  /** REDEEM only; recorded as the linked INTEREST companion. */
  accruedInterest?: number;
  /** Optional FX rate (security currency -> cash currency) to pin the cash posting. */
  exchangeRate?: number;
  description?: string;
  /** The bond series of a program-linked security: its code (`EDO1036`) or id. */
  bondSeriesCode?: string;
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

/**
 * Whether an edit leaves the bond series of a row alone: it names none that
 * differs from the stored one (a form resends the stored value on every save)
 * and changes nothing the series depends on -- the security, the action, the
 * date. Then the stored value is kept as it is, NULL included, and never
 * inferred or refused (INV-BOND-007).
 */
function keepsStoredSeries(
  stored: {
    securityId: string | null;
    action: string;
    transactionDate: string;
    bondInstrumentId: string | null;
  },
  dto: {
    securityId?: string | null;
    action?: string;
    transactionDate?: string;
    bondInstrumentId?: string | null;
  },
): boolean {
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? null)?.toLowerCase() === (b ?? null)?.toLowerCase();
  return (
    (dto.bondInstrumentId === undefined ||
      same(dto.bondInstrumentId, stored.bondInstrumentId)) &&
    (dto.securityId === undefined || same(dto.securityId, stored.securityId)) &&
    (dto.action === undefined || dto.action === stored.action) &&
    (dto.transactionDate === undefined ||
      String(dto.transactionDate).slice(0, 10) ===
        String(stored.transactionDate).slice(0, 10))
  );
}

@Injectable()
export class InvestmentTransactionsService {
  private readonly logger = new Logger(InvestmentTransactionsService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionsService))
    private transactionsService: TransactionsService,
    // forwardRef: HoldingsService sits on a require cycle back to this file, so
    // its reflected parameter type is `undefined` under some load orders --
    // see `src/module-graph.spec.ts`.
    @Inject(forwardRef(() => HoldingsService))
    private holdingsService: HoldingsService,
    private portfolioCalculationService: PortfolioCalculationService,
    private securitiesService: SecuritiesService,
    private securityPriceService: SecurityPriceService,
    private netWorthService: NetWorthService,
    private actionHistoryService: ActionHistoryService,
    private exchangeRateService: ExchangeRateService,
    private currenciesService: CurrenciesService,
    private bondHoldingsService: BondHoldingsService,
  ) {}

  /**
   * Actions whose cost basis *is* the price they carry.
   *
   * For these an omitted price is not a free purchase, it is a missing fact,
   * and the two must not be stored as the same thing. `price` is nullable
   * precisely so the replay can tell them apart -- but `create` collapsed the
   * distinction on the way in (`createDto.price ?? 0`), so by the time the
   * replay looked there was nothing left to distinguish: the units joined the
   * position, no cost joined the basis, the quantity reconciliation passed
   * because the units did add up, and an incomplete import came out as a
   * confident gain and a confident tax bill.
   *
   * `ADD_SHARES` is the action for units arriving without a cost, and it says
   * so: the replay marks the basis unknown rather than guessing. `TRANSFER_IN`
   * carries its basis from the paired `TRANSFER_OUT`, not from a price of its
   * own. Neither belongs here.
   */
  private static readonly PRICED_ACQUISITIONS: ReadonlySet<InvestmentAction> =
    new Set([
      InvestmentAction.BUY,
      InvestmentAction.REINVEST,
      InvestmentAction.REINVEST_INTEREST,
      InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
      InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
    ]);

  private static readonly PRICE_ACTIONS: ReadonlySet<InvestmentAction> =
    new Set([
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.REINVEST,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.TRANSFER_OUT,
      InvestmentAction.REDEEM,
      InvestmentAction.REINVEST_INTEREST,
      InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
      InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
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

  /**
   * The account an investment's cash actually lands in: the explicit funding
   * account when one is named, otherwise the brokerage's linked cash account
   * (or the account itself when it is not a linked brokerage).
   *
   * This is the single definition of "which account settles", and both the
   * currency pair below and {@link resolveSettlementAccountId} read it -- the
   * account and its currency must never be able to disagree.
   */
  private async resolveSettlementAccount(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
  ): Promise<Account> {
    return fundingAccountId
      ? this.accountsService.findOne(userId, fundingAccountId)
      : this.findCashAccount(userId, accountId);
  }

  /**
   * The id of the account an investment's cash lands in.
   *
   * Exposed because a balance projection has to charge the occurrence to the
   * account that actually pays for it: a scheduled investment's `accountId` is
   * the brokerage, so an account-level forecast keyed on that column charged the
   * wrong account and the funding account's own chart omitted the outflow
   * entirely (issue #1247).
   */
  async resolveSettlementAccountId(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
  ): Promise<string> {
    return (
      await this.resolveSettlementAccount(userId, accountId, fundingAccountId)
    ).id;
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
   * The currency pair an investment cash posting converts across:
   * `from` = the source currency (the security's currency, or -- for a
   * security-less action -- the investment account's currency); `to` = the
   * settlement/cash account's currency (the explicit funding account when one is
   * named, otherwise the brokerage's linked cash account).
   *
   * This is the single definition of that pair. `resolveCashExchangeRate` below
   * consumes it so the rate it fetches and the pair a stored rate is validated
   * against (the scheduled-investment provenance check, issue #1167) can never
   * drift apart. Same-currency pairs are reported as `{ X, X }`; the caller
   * decides what that means (a rate of 1, or a trivially-matching provenance).
   */
  async resolveSettlementCurrencyPair(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
    securityId: string | null | undefined,
  ): Promise<{ from: string; to: string }> {
    const cashAccount = await this.resolveSettlementAccount(
      userId,
      accountId,
      fundingAccountId,
    );

    let from: string;
    if (securityId) {
      const security = await this.securitiesService.findOne(userId, securityId);
      from = security.currencyCode;
    } else {
      const investmentAccount = await this.accountsService.findOne(
        userId,
        accountId,
      );
      from = investmentAccount.currencyCode;
    }

    return { from, to: cashAccount.currencyCode };
  }

  /**
   * Resolve the exchange rate used to convert a transaction's total amount
   * (expressed in the security's currency) into the cash account's currency.
   *
   * Precedence:
   *  1. Explicit override (the user entered a rate in the form, or an MCP/AI
   *     caller supplied one from the broker's settlement data).
   *  2. The market rate as of the transaction's date (stored, or fetched from
   *     Yahoo for that date), not the latest snapshot -- a back-dated buy must
   *     convert at the historical rate. No transaction date means today. The
   *     rate is `getRateForDate`'s answer: the newest observation on or before
   *     the date within `FX_MAX_RATE_AGE_DAYS`, never one struck after it.
   *
   * For a genuine cross-currency pair with no determinable rate this throws
   * rather than silently returning 1.0: posting at 1.0 corrupts the cash
   * balance and cost basis by the size of the FX rate (see issue #744).
   */
  private async resolveCashExchangeRate(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
    securityId: string | null | undefined,
    dtoRate: number | undefined,
    transactionDate?: string | Date,
    options?: { fetchMissing?: boolean },
  ): Promise<number> {
    const rate = await this.resolveCashExchangeRateOrNull(
      userId,
      accountId,
      fundingAccountId,
      securityId,
      dtoRate,
      transactionDate,
      options,
    );
    if (rate === null) {
      // Posting cannot proceed without a rate for a genuine cross-currency pair:
      // 1.0 corrupts the cash balance and cost basis by the size of the FX rate
      // (issue #744). The forecast, which cannot supply one, calls the OrNull
      // variant instead and renders the projection as unknown (issue #1167).
      const { from, to } = await this.resolveSettlementCurrencyPair(
        userId,
        accountId,
        fundingAccountId,
        securityId,
      );
      throw new BadRequestException(
        tr(
          "errors.securities.exchangeRateUnavailable",
          `Could not determine an exchange rate for ${from} -> ${to} on the transaction date. Supply an explicit exchangeRate so the cash posting is correct.`,
          { from, to },
        ),
      );
    }
    return rate;
  }

  /**
   * The settlement-pair FX resolution as a `number | null`: the same pair
   * derivation and rate path as {@link resolveCashExchangeRate}, but a genuine
   * cross-currency pair with no determinable rate returns `null` instead of
   * throwing. Posting wraps this and turns `null` into a `BadRequestException`;
   * the forecast read model (issue #1167) uses `null` directly to mark an
   * occurrence's projected cash impact as unknown rather than posting -- or
   * displaying -- a stale or 1.0 rate. Same-currency is `1` by definition, so it
   * is never confused with a missing rate.
   */
  async resolveCashExchangeRateOrNull(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
    securityId: string | null | undefined,
    dtoRate: number | undefined,
    transactionDate?: string | Date,
    /**
     * `fetchMissing: false` reads only the stored history: no provider call.
     * For a caller inside someone else's transaction, where an HTTP round trip
     * would hold that transaction's locks and connection (A26-L18).
     */
    options?: { fetchMissing?: boolean },
  ): Promise<number | null> {
    let supplied: number | undefined;
    if (dtoRate !== undefined && dtoRate !== null) {
      // A supplied rate is trusted but still has to be a rate. Zero used to be
      // accepted here (the DTO allowed @Min(0)): the preview then multiplied the
      // cash impact by 0 and showed no cash movement, while the committed cash
      // transaction ran `Number(rate) || 1` and posted the full amount at 1.0. A
      // user could approve a zero-cash preview and receive a 1,000 debit
      // (audit P5-005). Negative is equally not a rate. This is a caller error,
      // not a missing rate, so it throws in both variants.
      supplied = Number(dtoRate);
      if (!Number.isFinite(supplied) || supplied <= 0) {
        throw new BadRequestException(
          tr(
            "errors.securities.exchangeRateNotPositive",
            "Exchange rate must be greater than zero",
          ),
        );
      }
    }

    // One derivation of the pair, shared with the provenance check (issue #1167).
    const { from: sourceCurrency, to: cashCurrency } =
      await this.resolveSettlementCurrencyPair(
        userId,
        accountId,
        fundingAccountId,
        securityId,
      );

    // Same-currency settlement is 1 by definition and DOMINATES an explicit rate
    // (issue #1167): a non-1 scalar supplied for -- or stored against -- an X->X
    // pair (e.g. a rate that was legitimate before a security's currency changed
    // to the cash currency, then explicitly re-entered) must never convert an
    // amount away from par. This is checked *before* honouring `supplied`, and
    // after deriving the pair rather than the previous early return on `dtoRate`,
    // so an explicit 1.50 CAD/CAD resolves to 1, not 1.50.
    if (sourceCurrency === cashCurrency) {
      return 1;
    }

    if (supplied !== undefined) {
      return supplied;
    }

    // The rate as of the transaction date (fetching from the provider chain for
    // that date when not already stored). There is no fallback to the latest
    // stored snapshot: a rate for another date is not this date's rate, and
    // "unknown" is the answer that makes the caller supply one.
    const onDate = transactionDate || todayYMD();
    const rate =
      options?.fetchMissing === false
        ? await this.exchangeRateService.getRateForDate(
            sourceCurrency,
            cashCurrency,
            onDate,
            { fetchMissing: false },
          )
        : await this.exchangeRateService.getRateForDate(
            sourceCurrency,
            cashCurrency,
            onDate,
          );

    if (rate === null || !(Number(rate) > 0)) {
      // Unknown, not applicable: a zero/negative or absent rate is "no rate".
      return null;
    }

    return Number(rate);
  }

  private async createCashTransactionInTransaction(
    manager: EntityManager,
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
    const payeeName = formatInvestmentCashPayeeName({
      action: investmentTransaction.action,
      symbol,
      quantity: investmentTransaction.quantity,
      price: investmentTransaction.price,
      totalAmount: investmentTransaction.totalAmount,
      currencyCode: sourceCurrency,
    });

    // A stored rate is validated positive on the way in, and is absent only for
    // a same-currency posting -- so `??` rather than `||`, which would also have
    // swallowed a stored 0 and posted the full amount unconverted.
    const storedRate = investmentTransaction.exchangeRate;
    const exchangeRate =
      storedRate === null || storedRate === undefined ? 1 : Number(storedRate);
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

    // The cash leg is created with the investment row's status -- the two rows
    // describe one event, and a VOID trade's cash leg saying CLEARED would be
    // the pair describing two different events. Afterwards only the VOID
    // boundary stays shared; reconciliation states are per-ledger.
    const status =
      investmentTransaction.status ?? TransactionStatus.UNRECONCILED;

    const cashTransaction = manager.create(Transaction, {
      userId,
      accountId: cashAccount.id,
      transactionDate: investmentTransaction.transactionDate,
      amount: cashAmount,
      currencyCode: cashAccount.currencyCode,
      exchangeRate,
      payeeName,
      payeeId: null,
      description: investmentTransaction.description,
      status,
    });

    const saved = await manager.save(cashTransaction);

    // Defer the live balance update for future-dated cash entries -- the
    // hourly applyDueTransactionBalances cron rolls them into currentBalance
    // when the user's local date catches up. Crediting now would double-count
    // once the cron runs. A VOID leg records a movement that did not happen,
    // so it never moves the balance at all.
    if (
      status !== TransactionStatus.VOID &&
      !isTransactionInFuture(investmentTransaction.transactionDate)
    ) {
      await this.accountsService.updateBalance(cashAccount.id, cashAmount);
    }

    return saved.id;
  }

  private async deleteCashTransactionInTransaction(
    manager: EntityManager,
    userId: string,
    transactionId: string | null,
  ): Promise<void> {
    if (!transactionId) return;

    // Locked, and the reversal gated on the row the database actually removed:
    // reversing an amount whose row is already gone is the double-delete
    // corruption in P4-003.
    const cashTransaction = await lockTransactionRow(
      manager,
      transactionId,
      userId,
    );

    if (cashTransaction) {
      const removed = await manager.delete(Transaction, {
        id: transactionId,
        userId,
      });
      if ((removed.affected ?? 0) === 0) return;
      // The one deletion-reversal rule, from the shared helper: a VOID or
      // future-dated row contributed nothing to the balance.
      const effect = deletionBalanceEffect(cashTransaction);
      if (effect.delta !== 0) {
        await this.accountsService.updateBalance(
          cashTransaction.accountId,
          effect.delta,
        );
      }
      if (effect.needsRecalc) {
        await this.accountsService.recalculateCurrentBalance(
          userId,
          cashTransaction.accountId,
        );
      }
    }
  }

  /**
   * Refuse an acquisition that does not say what it cost.
   *
   * One method rather than one check per entry point, because there are three
   * ways into this table -- `create`, `update` and `createEmbeddedForSplit` --
   * and a rule enforced by only one of them is not a rule. The first version
   * of this guard lived in `create` alone: the embedded-split path still wrote
   * `dto.price ?? 0`, and `update` would happily set an existing purchase's
   * price to zero, so a "free" acquisition could be created or edited into
   * existence and its cost, gain and tax were all reported as known.
   *
   * Zero is refused along with absent. A zero-cost purchase is not a concept
   * this application has; shares that arrived without a cost are `ADD_SHARES`,
   * which records that the cost is unknown rather than nil.
   */
  private assertAcquisitionPriced(
    action: InvestmentAction,
    price: number | null | undefined,
  ): void {
    if (!InvestmentTransactionsService.PRICED_ACQUISITIONS.has(action)) return;
    if (Number(price) > 0) return;
    throw new BadRequestException(
      tr(
        "errors.securities.acquisitionPriceRequired",
        `Price per share is required and must be greater than zero for ${action} transactions. Use ADD_SHARES for shares acquired without a known cost.`,
        { action },
      ),
    );
  }

  /**
   * Refuse accrued interest where it cannot be honoured, before anything is
   * written. REDEEM alone carries it (`ACCRUED_INTEREST_ACTIONS`), and an
   * embedded row cannot: the parent split's leg is already the cash side there,
   * so a companion would move money the parent has not accounted for.
   */
  private assertAccruedInterestAllowed(
    action: InvestmentAction,
    accruedInterest: number | null | undefined,
    isEmbedded: boolean,
  ): void {
    const amount = Number(accruedInterest ?? 0);
    if (!(amount > 0)) return;
    if (!supportsAccruedInterest(action)) {
      throw new BadRequestException(
        tr(
          "errors.securities.accruedInterestActionNotAllowed",
          `Accrued interest can only be recorded on a REDEEM transaction, not on ${action}.`,
          { action },
        ),
      );
    }
    if (isEmbedded) {
      throw new BadRequestException(
        tr(
          "errors.securities.accruedInterestNotAllowedInSplit",
          "Accrued interest cannot be recorded on an investment transaction inside a split. Record the interest as its own split line instead.",
        ),
      );
    }
  }

  /**
   * The INTEREST companion of a redemption, or null.
   *
   * `linked_transaction_id` also links transfer legs, so the pair is identified
   * by action rather than by the link alone (`isAccruedInterestCompanion`).
   */
  private async findAccruedInterestCompanion(
    manager: EntityManager,
    userId: string,
    redemption: Pick<
      InvestmentTransaction,
      "id" | "action" | "linkedTransactionId"
    >,
  ): Promise<InvestmentTransaction | null> {
    if (!redemption.linkedTransactionId) return null;
    if (!supportsAccruedInterest(redemption.action)) return null;

    // includes VOID rows: records read -- a VOID redemption's companion is VOID
    // too, and both are still loaded so an edit or delete reaches the pair.
    const companion = await manager
      .getRepository(InvestmentTransaction)
      .findOne({ where: { id: redemption.linkedTransactionId, userId } });

    return companion && isAccruedInterestCompanion(companion, redemption)
      ? companion
      : null;
  }

  /**
   * Make the companion match the redemption's accrued interest: create it,
   * re-amount it, or delete it when the interest goes to zero.
   *
   * The companion writes no cash row of its own (`transactionId` stays null) --
   * the redemption's single cash row already carries the interest, and a second
   * one would move the money twice. Its status is the redemption's, because the
   * two rows describe one event.
   */
  private async syncAccruedInterestCompanion(
    manager: EntityManager,
    userId: string,
    redemption: InvestmentTransaction,
    accruedInterest: number,
    /**
     * The companion as it was before this edit, resolved while the row still
     * had its stored action. Passed in rather than looked up here because an
     * edit that turns a REDEEM into something else must still be able to find
     * the companion it has to delete.
     */
    existing: InvestmentTransaction | null,
  ): Promise<void> {
    // includes VOID rows: records written -- the companion carries the
    // redemption's status, VOID included, so it is created and re-amounted
    // whatever that status is.
    const repo = manager.getRepository(InvestmentTransaction);
    const amount = roundMoney(Number(accruedInterest) || 0);

    if (!(amount > 0)) {
      if (existing) {
        // Break the link first so neither row's FK points at a row that is
        // about to disappear.
        await repo.update(redemption.id, { linkedTransactionId: null });
        redemption.linkedTransactionId = null;
        await repo.update(existing.id, { linkedTransactionId: null });
        await repo.delete({ id: existing.id, userId });
      }
      redemption.accruedInterest = 0;
      return;
    }

    if (existing) {
      // Quantity stays null and price carries the amount, so any recompute of
      // `totalAmount` for an INTEREST row lands on the same figure.
      existing.accountId = redemption.accountId;
      existing.securityId = redemption.securityId;
      existing.transactionDate = redemption.transactionDate;
      existing.status = redemption.status;
      existing.exchangeRate = redemption.exchangeRate;
      existing.price = amount;
      existing.totalAmount = amount;
      await repo.save(existing);
      redemption.accruedInterest = amount;
      return;
    }

    const companion = repo.create({
      userId,
      accountId: redemption.accountId,
      securityId: redemption.securityId,
      fundingAccountId: null,
      action: InvestmentAction.INTEREST,
      transactionDate: redemption.transactionDate,
      quantity: null,
      price: amount,
      commission: 0,
      totalAmount: amount,
      exchangeRate: redemption.exchangeRate,
      description: redemption.description,
      status: redemption.status,
      transactionId: null,
      linkedTransactionId: redemption.id,
    });
    const savedCompanion = await repo.save(companion);

    await repo.update(redemption.id, {
      linkedTransactionId: savedCompanion.id,
    });
    redemption.linkedTransactionId = savedCompanion.id;
    redemption.accruedInterest = amount;
  }

  /** Attach each redemption's accrued interest to the rows being returned. */
  private async attachAccruedInterest(
    manager: EntityManager,
    userId: string,
    rows: InvestmentTransaction[],
  ): Promise<void> {
    const redemptions = rows.filter(
      (row) => supportsAccruedInterest(row.action) && row.linkedTransactionId,
    );
    for (const row of rows) {
      if (supportsAccruedInterest(row.action)) row.accruedInterest = 0;
    }
    if (redemptions.length === 0) return;

    // includes VOID rows: records read -- a VOID redemption still shows what
    // its accrued interest was.
    const companions = await manager.getRepository(InvestmentTransaction).find({
      where: redemptions.map((row) => ({
        id: row.linkedTransactionId as string,
        userId,
      })),
    });
    const byId = new Map(companions.map((row) => [row.id, row]));

    for (const row of redemptions) {
      const companion = byId.get(row.linkedTransactionId as string);
      if (companion && isAccruedInterestCompanion(companion, row)) {
        row.accruedInterest = Number(companion.totalAmount);
      }
    }
  }

  async create(
    userId: string,
    createDto: CreateInvestmentTransactionDto,
    options: {
      deferBondRecompute?: boolean;
      /**
       * Runs first in the write's transaction, after the holdings lock and
       * before anything is written; a throw rolls the whole creation back.
       * How a confirmed AI review request is marked applied together with the
       * row it proposed.
       */
      beforeWrite?: (manager: EntityManager) => Promise<void>;
      /**
       * Runs last in the write's transaction, with the row's id; a throw rolls
       * the whole creation back. How a trade email records the row its
       * approval booked.
       */
      afterWrite?: (manager: EntityManager, id: string) => Promise<void>;
    } = {},
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
        // A return of capital reduces one security's basis, so it must name it.
        InvestmentAction.RETURN_OF_CAPITAL,
      ].includes(baseInvestmentAction(createDto.action) as InvestmentAction) &&
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

    // The executed total is the fact and the price follows it, so the price
    // this write stores -- and the one the acquisition guard judges -- is the
    // resolved one, not the (possibly cent-rounded) figure the caller typed.
    const amounts = resolveInvestmentAmounts(createDto);

    this.assertAcquisitionPriced(createDto.action, amounts.price);

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

    const totalAmount = amounts.totalAmount;
    const accruedInterest = roundMoney(Number(createDto.accruedInterest ?? 0));
    this.assertAccruedInterestAllowed(createDto.action, accruedInterest, false);

    // Resolve the rate that will convert totalAmount (security currency)
    // into the cash account's currency when we post the linked cash transaction.
    const exchangeRate = await this.resolveCashExchangeRate(
      userId,
      createDto.accountId,
      createDto.fundingAccountId ?? null,
      createDto.securityId ?? null,
      createDto.exchangeRate,
      createDto.transactionDate,
    );

    const savedId = await withScopedDb(this.dataSource, async (manager) => {
      // First statement of the transaction: advisory locks are taken before row
      // locks (see `common/db/locks.ts`), and the cash effects below row-lock
      // `accounts`. The rebuild at the end takes this same lock; an advisory
      // xact lock is re-entrant, so taking it here costs nothing and is what
      // keeps this path in the one order every holdings writer uses.
      await lockHoldingScope(manager, [createDto.accountId]);

      await options.beforeWrite?.(manager);

      // A removal the account cannot cover (OVER_REMOVAL,
      // REMOVAL_EXCEEDS_SERIES) is refused after the mutation, in this
      // transaction, so nothing commits (INV-BOND-007).
      const bondGuard = await beginBondWriteGuard(manager, userId, [
        createDto.securityId,
      ]);

      // The series of a program-linked security (INV-BOND-007): given and
      // checked, inferred from the date of a BUY or REINVEST, required of the
      // other acquisitions; refused before anything is written.
      const bondInstrumentId = await resolveTransactionSeries(manager, userId, {
        securityId: createDto.securityId,
        action: createDto.action,
        transactionDate: createDto.transactionDate,
        bondInstrumentId: createDto.bondInstrumentId,
        requested: true,
      });

      const investmentTransaction = manager.create(InvestmentTransaction, {
        userId,
        accountId: createDto.accountId,
        securityId: createDto.securityId,
        bondInstrumentId,
        fundingAccountId: createDto.fundingAccountId || null,
        action: createDto.action,
        transactionDate: createDto.transactionDate,
        quantity: createDto.quantity ?? 0,
        // Null, not zero. The column is nullable so "no price was given" and
        // "it cost nothing" stay two different rows; `?? 0` made every
        // unpriced action indistinguishable from a free one downstream.
        price: amounts.price,
        commission: createDto.commission || 0,
        totalAmount,
        exchangeRate,
        description: createDto.description,
        // Part of what the row is created WITH, so no path can apply an
        // active effect for a VOID event and fix the status up afterwards.
        status: createDto.status ?? TransactionStatus.UNRECONCILED,
      });

      const saved = await manager.save(investmentTransaction);

      // Before the effects: the cash row the effects create carries the
      // interest as well as the proceeds, and there is only one of them.
      await this.syncAccruedInterestCompanion(
        manager,
        userId,
        saved,
        accruedInterest,
        null,
      );

      await this.processTransactionEffectsInTransaction(
        manager,
        userId,
        saved,
        true,
        accruedInterest,
      );

      // The holding is re-derived from the ledger this row has just joined, in
      // this transaction and under the holdings lock. Insertion order is not
      // economic order: a back-dated trade entered last still has to settle
      // into the position where its date puts it.
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        saved.securityId
          ? [{ accountId: saved.accountId, securityId: saved.securityId }]
          : [],
        manager,
      );

      // Refused inside the transaction, so a create that would oversell the
      // position at any date leaves nothing written.
      if (saved.securityId) {
        await this.holdingsService.validateNoNegativeHoldingsHistory(
          userId,
          manager,
          [saved.accountId],
          [saved.securityId],
        );
      }

      await bondGuard.verify([saved.id]);

      await options.afterWrite?.(manager, saved.id);

      return saved.id;
    });

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
      createDto.status !== TransactionStatus.VOID &&
      InvestmentTransactionsService.PRICE_ACTIONS.has(createDto.action)
    ) {
      // A VOID trade's price is not a settled observation, so it contributes
      // no transaction-derived price row.
      this.securityPriceService
        .upsertTransactionPrice(createDto.securityId, createDto.transactionDate)
        .catch((err) =>
          this.logger.warn(
            `Failed to update transaction-derived price: ${err.message}`,
          ),
        );
    }

    // A trade on a bond-linked security changes its lots: the engine's prices
    // are recomputed now that the write has committed (a bulk caller recomputes
    // once per security at the end).
    if (!options.deferBondRecompute && createDto.status !== "VOID") {
      await this.securitiesService.recomputeBondPricesAfterWrite(userId, [
        createDto.securityId,
      ]);
    }

    const result = await this.findOne(userId, savedId);

    // Capture linked cash transaction for redo support
    const afterData: Record<string, unknown> = { ...result };
    if (result.transactionId) {
      const cashTx = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Transaction).findOne({
          where: { id: result.transactionId!, userId },
        }),
      );
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
   * `create()` (its own scoped transaction, holdings/cash effects, action
   * history) so a
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
        created.push(
          await this.create(userId, dtos[index], { deferBondRecompute: true }),
        );
      } catch (error) {
        skipped.push({ index, reason: bulkSkipReason(error) });
        this.logger.warn(
          `Bulk investment row ${index} skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    // Once per security, after the whole batch has committed.
    await this.securitiesService.recomputeBondPricesAfterWrite(
      userId,
      created.map((row) => row.securityId),
    );
    return { created, skipped };
  }

  /**
   * The split of a bond redemption applied to what the caller supplied
   * (`applyRedemptionSplit`), or null when the security is not linked to a bond
   * program, or the caller stated both price and accrued interest and the split
   * cannot be worked out (the write guard still refuses what is wrong). With
   * no series named, the one series the account holds is used and (for a new
   * row) named on it; none or several are refused, because the split is of one
   * series' lots. A refused split refuses the preview: no price or interest is
   * ever guessed.
   */
  private async fillBondRedemption(
    userId: string,
    row: {
      accountId: string;
      securityId: string;
      transactionDate: string;
      quantity: number;
      price: number | null;
      totalAmount: number | undefined;
      commission: number;
      accruedInterest: number;
      series: { id: string | null; code: string | null };
      excludeTransactionId?: string;
      pinSeries: boolean;
    },
  ): Promise<{
    series: { id: string | null; code: string | null };
    filled: FilledRedemption;
  } | null> {
    const linked = await withScopedDb(
      this.dataSource,
      async (m) =>
        (await programOfSecurity(m, userId, row.securityId)) !== null,
    );
    if (!linked || !Number.isInteger(row.quantity) || row.quantity <= 0) {
      return null;
    }
    const bothStated =
      row.accruedInterest > 0 &&
      (row.price !== null || row.totalAmount !== undefined);
    const date = String(row.transactionDate).slice(0, 10);

    let series = row.series;
    let splitSeriesId = series.id;
    if (splitSeriesId === null) {
      const { holdings } = await this.bondHoldingsService.seriesHoldings(
        userId,
        row.securityId,
        row.accountId,
        date,
        row.excludeTransactionId,
      );
      if (holdings.length !== 1) {
        if (bothStated) return null;
        throw new BadRequestException({
          message: tr(
            "errors.bonds.REDEEM_SERIES_REQUIRED",
            `Name the bond series being redeemed (bondSeriesCode): the account holds ${holdings.length} series of this security on ${date}, so the price and accrued interest cannot be worked out from the redemption split.`,
            { count: String(holdings.length), date },
          ),
          errorCode: "REDEEM_SERIES_REQUIRED",
        });
      }
      splitSeriesId = holdings[0].instrumentId;
      if (row.pinSeries) {
        series = { id: splitSeriesId, code: holdings[0].seriesCode };
      }
    }

    let split;
    try {
      split = await this.bondHoldingsService.redemptionSplit(
        userId,
        row.securityId,
        row.accountId,
        splitSeriesId,
        date,
        row.quantity,
        row.excludeTransactionId,
      );
    } catch (error) {
      // A removal the account cannot cover is the write guard's refusal; when
      // the caller stated both figures the split is only a comparison.
      if (bothStated && error instanceof HttpException) return null;
      throw error;
    }
    if (
      split.refusal !== null ||
      split.payout === null ||
      split.interest === null ||
      split.principalReturned === null ||
      split.principal === null ||
      split.deduction === null
    ) {
      if (bothStated) return null;
      const code = split.refusal ?? "RATE_UNKNOWN";
      throw new BadRequestException({
        message: tr(
          "errors.bonds.REDEMPTION_SPLIT_REFUSED",
          `The redemption of series ${series.code ?? ""} on ${date} cannot be split into returned principal and interest (${code}), so no price or accrued interest was filled in. Correct the date or quantity, or enter both the price and the accrued interest yourself.`,
          { series: series.code ?? "", date, code },
        ),
        errorCode: code,
      });
    }
    return {
      series,
      filled: applyRedemptionSplit(
        {
          principal: Number(split.principal),
          deduction: Number(split.deduction),
          interest: Number(split.interest),
          principalReturned: Number(split.principalReturned),
          payout: Number(split.payout),
        },
        {
          quantity: row.quantity,
          price: row.price,
          totalAmount: row.totalAmount,
          commission: row.commission,
          accruedInterest: row.accruedInterest,
        },
      ),
    };
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
      /** The executed total, when the caller knows it; see `create()`. */
      totalAmount?: number;
      accruedInterest?: number;
      fundingAccountId?: string;
      exchangeRate?: number;
      description?: string;
      /** The bond series by code or id; wins over `bondInstrumentId`. */
      bondSeriesCode?: string;
      /** A series the row already stores (an edit): kept unless it no longer fits. */
      bondInstrumentId?: string | null;
      /**
       * The row an edit starts from. With no series named, a change of none of
       * the security, action or date keeps its stored series as it is, NULL
       * included (what `update()` does, INV-BOND-007).
       */
      editing?: {
        transactionId: string;
        securityId: string | null;
        action: string;
        transactionDate: string;
        bondInstrumentId: string | null;
        /**
         * The row's own rate. Kept when the edit names none and leaves the
         * security as it is: what `update()` does (INV-FX-002), and the rate the
         * adapters commit is the one this preview returns.
         */
        exchangeRate?: number;
      };
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
      InvestmentAction.RETURN_OF_CAPITAL,
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
    const commission = roundToDecimals(Number(input.commission ?? 0), 4);
    const suppliedInterest = roundToDecimals(
      Number(input.accruedInterest ?? 0),
      4,
    );
    this.assertAccruedInterestAllowed(input.action, suppliedInterest, false);

    // The series the commit will store, resolved by the same function and
    // refused the same way (INV-BOND-007), so the person is not asked to confirm
    // what cannot be written. An edit that changes none of the security, the
    // action and the date, and names no series, keeps the stored one as it is.
    const keepStored =
      input.editing !== undefined &&
      !input.bondSeriesCode?.trim() &&
      keepsStoredSeries(input.editing, {
        securityId: security?.id ?? null,
        action: input.action,
        transactionDate: input.transactionDate,
        bondInstrumentId: undefined,
      });
    let series = await withScopedDb(this.dataSource, async (m) => {
      const id = await resolveTransactionSeries(m, userId, {
        keepStored,
        securityId: security?.id,
        action: input.action,
        transactionDate: input.transactionDate,
        bondInstrumentId: input.bondInstrumentId,
        bondSeriesReference: input.bondSeriesCode,
        requested: false,
      });
      return { id, code: await seriesCodeOf(m, id) };
    });

    // A redemption of a bond-linked security: the server works out the split of
    // what it pays into returned principal and interest, so the interest is not
    // booked as a capital gain (INV-BOND-009). A preview is the commit's code.
    let suppliedPrice: number | null =
      input.price !== undefined && input.price !== null
        ? roundToDecimals(Number(input.price), INVESTMENT_PRICE_DECIMALS)
        : null;
    let suppliedTotal = input.totalAmount;
    let accruedInterest = suppliedInterest;
    let redemptionSplit: BondRedemptionSplitPreview | null = null;
    if (
      input.action === InvestmentAction.REDEEM &&
      security &&
      quantity !== null
    ) {
      const redemption = await this.fillBondRedemption(userId, {
        accountId: input.accountId,
        securityId: security.id,
        transactionDate: input.transactionDate,
        quantity,
        price: suppliedPrice,
        totalAmount: suppliedTotal,
        commission,
        accruedInterest,
        series,
        excludeTransactionId: input.editing?.transactionId,
        // A new row names the series its split was worked out for; an edit
        // keeps the stored one as it is (INV-BOND-007).
        pinSeries: input.editing === undefined,
      });
      if (redemption) {
        series = redemption.series;
        suppliedPrice = redemption.filled.price;
        suppliedTotal = redemption.filled.totalAmount;
        accruedInterest = redemption.filled.accruedInterest;
        redemptionSplit = redemption.filled.split;
      }
    }

    // The same door the write goes through, so a preview of a trade entered by
    // its executed total shows the total the commit will store and the price it
    // will derive -- at the price column's own ten decimals, not six.
    const { totalAmount, price } = resolveInvestmentAmounts({
      action: input.action,
      quantity,
      price: suppliedPrice,
      commission,
      totalAmount: suppliedTotal,
    });

    // An edit that names no rate and keeps the security keeps the row's own
    // rate: the account and the funding account cannot change through the
    // edit preview, so the currency pair is the stored one (A26-M20). Only a
    // different security re-resolves, for its pair, as `update()` does.
    const keptRate =
      input.exchangeRate === undefined &&
      input.editing?.exchangeRate !== undefined &&
      (security?.id ?? null) === input.editing.securityId
        ? input.editing.exchangeRate
        : undefined;
    const exchangeRate = await this.resolveCashExchangeRate(
      userId,
      input.accountId,
      input.fundingAccountId ?? null,
      security?.id ?? null,
      input.exchangeRate ?? keptRate,
      input.transactionDate,
      // A preview built inside a caller's transaction (the email-receipt
      // pipeline holds the receipt's row lock while it builds a trade card)
      // reads only the stored rates: a provider call there would hold the
      // lock and a pooled connection for the provider's response time, and
      // its fetched window would commit or roll back with the receipt. A
      // missing rate is then refused by name, and the card waits for the
      // rate cron (A26-L18). A request-scoped preview still fetches.
      { fetchMissing: getActiveScopedManager() === undefined },
    );

    // Signed cash impact in the security's currency, converted to the cash
    // account's currency for display. Zero for the share-only actions, which
    // create no linked cash transaction.
    const cashImpactSecurity = computeInvestmentCashImpact(
      input.action,
      Number(quantity ?? 0),
      Number(price ?? 0),
      commission,
      accruedInterest,
      totalAmount,
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
      accruedInterest,
      totalAmount,
      exchangeRate,
      fundingAccountId: fundingAccount?.id ?? null,
      cashAccountName,
      cashCurrency,
      cashAmount,
      description: stripHtml(input.description) || null,
      bondInstrumentId: series.id,
      bondSeriesCode: series.code,
      redemptionSplit,
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
      accruedInterest?: number;
      exchangeRate?: number;
      description?: string;
      bondSeriesCode?: string;
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
      input.accruedInterest !== undefined ||
      input.exchangeRate !== undefined ||
      input.description !== undefined ||
      input.bondSeriesCode !== undefined;
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
      // `findOne` reads it off the companion, so an edit that does not mention
      // the interest keeps it -- the same rule `update()` applies.
      accruedInterest:
        input.accruedInterest ?? Number(existing.accruedInterest ?? 0),
      fundingAccountId: existing.fundingAccountId ?? undefined,
      // Only an explicit override changes the rate; otherwise the row keeps
      // its own unless the security changes (`editing.exchangeRate` below),
      // matching update()'s precedence. The adapters commit what this
      // preview returns, so a re-resolved market rate here would be written
      // as if the person had asked for it.
      exchangeRate: input.exchangeRate,
      description: input.description ?? existing.description ?? undefined,
      bondSeriesCode: input.bondSeriesCode,
      // Kept as stored unless the edit names another (or no longer fits).
      bondInstrumentId: existing.bondInstrumentId,
      // With no series named, an edit that changes none of the security, the
      // action and the date keeps the stored series as it is, NULL included.
      editing: {
        transactionId,
        securityId: existing.securityId,
        action: existing.action,
        transactionDate: existing.transactionDate,
        bondInstrumentId: existing.bondInstrumentId,
        exchangeRate: Number(existing.exchangeRate),
      },
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
      accruedInterest: preview.accruedInterest,
      bondSeriesCode: preview.bondSeriesCode,
      bondRedemptionSplit: preview.redemptionSplit,
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
      accruedInterest: row.accruedInterest,
      fundingAccountId,
      exchangeRate: row.exchangeRate,
      description: row.description,
      bondSeriesCode: row.bondSeriesCode,
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
          accruedInterest: row.accruedInterest,
          fundingAccountId,
          exchangeRate: row.exchangeRate,
          description: row.description,
          bondSeriesCode: row.bondSeriesCode,
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
            accruedInterest: row.accruedInterest,
            exchangeRate: row.exchangeRate,
            description: row.description,
            bondSeriesCode: row.bondSeriesCode,
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
          accruedInterest: preview.accruedInterest,
          exchangeRate: preview.exchangeRate,
          description: preview.description,
          bondInstrumentId: preview.bondInstrumentId,
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
   * destination account at the per-share basis the source released at the
   * transfer's date (A26-M22). No cash
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

    // Transfer legs carry no cash, so totalAmount is 0 -- matching how
    // calculateTotalAmount() treats TRANSFER_IN/TRANSFER_OUT on the edit path.
    // Cost basis flows through quantity * price (per-share cost) instead.
    const totalAmount = 0;

    const { outId, inId } = await withScopedDb(
      this.dataSource,
      async (manager) => {
        // First statement of the transaction: advisory before row locks
        // (`common/db/locks.ts`), both accounts, ascending inside the helper.
        await lockHoldingScope(manager, [dto.fromAccountId, dto.toAccountId]);

        // Optional for a transfer (it moves lots, keeping their series); named,
        // it must belong to the security's program and both legs carry it.
        const bondGuard = await beginBondWriteGuard(manager, userId, [
          dto.securityId,
        ]);
        const bondInstrumentId = await resolveTransactionSeries(
          manager,
          userId,
          {
            securityId: dto.securityId,
            action: InvestmentAction.TRANSFER_OUT,
            transactionDate: dto.transactionDate,
            bondInstrumentId: dto.bondInstrumentId,
            requested: true,
          },
        );

        const transferOut = manager.create(InvestmentTransaction, {
          userId,
          accountId: dto.fromAccountId,
          securityId: dto.securityId,
          bondInstrumentId,
          fundingAccountId: null,
          action: InvestmentAction.TRANSFER_OUT,
          transactionDate: dto.transactionDate,
          quantity: dto.quantity,
          // Provisional: replaced below by the basis the ledger says this leg
          // relieves. The client's figure is only the fallback for a source
          // that does not hold the units on this date.
          price: dto.costPerShare,
          commission: 0,
          totalAmount,
          exchangeRate: 1,
          description: dto.description,
        });
        const savedOut = await manager.save(transferOut);
        const outId = savedOut.id;
        await this.processTransactionEffectsInTransaction(
          manager,
          userId,
          savedOut,
          false,
        );

        // Carry the source's basis AT THE TRANSFER'S DATE, read from the ledger
        // under the lock (A26-M22). The stored holding is today's average --
        // after a later buy it is not what the source held on the transfer's
        // date -- and the client's costPerShare is display only: a stale or zero
        // value must not be able to poison the destination's basis. The server
        // is authoritative: both legs take what the OUT leg relieves at its
        // position in the replay, divided by the quantity. `null` (the source
        // does not hold the units on that date) keeps the client figure; the
        // over-draw guard below refuses that transfer anyway.
        const releasedPerShare =
          await this.holdingsService.releasedBasisPerShare(
            userId,
            dto.securityId,
            outId,
            manager,
          );
        const carriedCost =
          releasedPerShare !== null
            ? roundToDecimals(releasedPerShare, INVESTMENT_PRICE_DECIMALS)
            : dto.costPerShare;
        if (releasedPerShare !== null) {
          await manager.update(InvestmentTransaction, outId, {
            price: carriedCost,
          });
        }

        const transferIn = manager.create(InvestmentTransaction, {
          userId,
          accountId: dto.toAccountId,
          securityId: dto.securityId,
          bondInstrumentId,
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
        const savedIn = await manager.save(transferIn);
        const inId = savedIn.id;
        await this.processTransactionEffectsInTransaction(
          manager,
          userId,
          savedIn,
          false,
        );

        // Link the two legs to each other so a later edit or delete of one
        // cascades to its pair.
        await manager.update(InvestmentTransaction, outId, {
          linkedTransactionId: inId,
        });
        await manager.update(InvestmentTransaction, inId, {
          linkedTransactionId: outId,
        });

        // Both legs' positions come from the ledger the two rows have just
        // joined, so the destination's basis is the source's replayed average
        // cost rather than a delta blended onto whatever was stored.
        await this.holdingsService.rebuildScopesFromTransactions(
          userId,
          [
            { accountId: dto.fromAccountId, securityId: dto.securityId },
            { accountId: dto.toAccountId, securityId: dto.securityId },
          ],
          manager,
        );

        // Guard against transferring more than the source holds. Validates the
        // full replayed history so it catches both the immediate over-draw and
        // any back-dated transfer that would make a past balance go negative.
        await this.holdingsService.validateNoNegativeHoldingsHistory(
          userId,
          manager,
          [dto.fromAccountId, dto.toAccountId],
          [dto.securityId],
        );

        await bondGuard.verify([outId, inId]);

        return { outId, inId };
      },
    );

    this.triggerRecalcWithCashAccount(dto.fromAccountId, userId);
    this.triggerRecalcWithCashAccount(dto.toAccountId, userId);

    this.securityPriceService
      .upsertTransactionPrice(dto.securityId, dto.transactionDate)
      .catch((err) =>
        this.logger.warn(
          `Failed to update transaction-derived price: ${err.message}`,
        ),
      );

    await this.securitiesService.recomputeBondPricesAfterWrite(userId, [
      dto.securityId,
    ]);

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

  /**
   * The total a price implies. Only for a caller that has no executed total of
   * its own -- one that does goes through `resolveInvestmentAmounts`, which
   * stores the total as the fact and derives the price from it.
   */
  private calculateTotalAmount(dto: {
    action: InvestmentAction;
    quantity?: number | null;
    price?: number | null;
    commission?: number | null;
  }): number {
    return deriveInvestmentTotal(dto);
  }

  private async processTransactionEffectsInTransaction(
    manager: EntityManager,
    userId: string,
    transaction: InvestmentTransaction,
    createCashSide: boolean = true,
    /**
     * Accrued interest riding on this row's single cash movement. Only a
     * redemption has any; it is added to the proceeds for the cash row alone,
     * never to `totalAmount`, which every realized-gain fold measures against
     * cost basis.
     */
    accruedInterest: number = 0,
  ): Promise<void> {
    // Holdings are NOT written here. A stored holding is a projection of the
    // ledger, rebuilt for the touched (account, security) scopes by
    // `HoldingsService.rebuildScopesFromTransactions` once the caller has
    // finished writing the rows -- an incremental delta applied here blended
    // the average cost in insertion order, so a back-dated trade stored a
    // number the replay disagrees with (issue #1388). This method now owns the
    // linked cash leg only, which a future-dated or VOID row still gets (it
    // shows in the cash ledger as a projected or voided entry, moving no
    // balance).
    const { action, accountId, totalAmount, fundingAccountId } = transaction;

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

    switch (baseInvestmentAction(action)) {
      case InvestmentAction.BUY:
        if (createCashSide && cashAccount) {
          cashTransactionId = await this.createCashTransactionInTransaction(
            manager,
            userId,
            cashAccount,
            transaction,
            -Number(totalAmount),
          );
        }
        break;

      case InvestmentAction.SELL:
        if (createCashSide && cashAccount) {
          cashTransactionId = await this.createCashTransactionInTransaction(
            manager,
            userId,
            cashAccount,
            transaction,
            disposalCashAmount(totalAmount, accruedInterest),
          );
        }
        break;

      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
      case InvestmentAction.RETURN_OF_CAPITAL:
        if (createCashSide && cashAccount) {
          cashTransactionId = await this.createCashTransactionInTransaction(
            manager,
            userId,
            cashAccount,
            transaction,
            Number(totalAmount),
          );
        }
        break;

      // REINVEST / SPLIT / TRANSFER_IN / TRANSFER_OUT / ADD_SHARES /
      // REMOVE_SHARES move shares and no cash, so they have nothing to do here.
    }

    if (cashTransactionId) {
      await manager.update(InvestmentTransaction, transaction.id, {
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
    manager: EntityManager,
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
      accruedInterest?: number | null;
      exchangeRate?: number | null;
      description?: string | null;
      /** The bond series, for a program-linked security (INV-BOND-007). */
      bondInstrumentId?: string | null;
    },
    /**
     * Cash amount the parent split records for this action, in the CASH
     * account's currency. Checked against the cash impact converted at the rate
     * actually resolved below, so the two halves of one split cannot disagree.
     * Omitted by callers that have no split amount to check.
     */
    splitAmount?: number,
    /**
     * The parent transaction's status. The parent owns an embedded row's
     * status: a VOID parent's investment row is created VOID and applies no
     * holdings, for the same reason its transfer counterparts are created VOID.
     */
    parentStatus?: TransactionStatus,
    /**
     * The series the same split's embedded row carried before the parent was
     * edited (`takeCarriedSeries`), NULL included. Used when `dto` names none:
     * a parent-only edit rebuilds the embedded rows, and must not ask for a
     * series the row never needed to be re-inferred for (INV-BOND-007).
     */
    carriedSeries?: { readonly bondInstrumentId: string | null } | null,
  ): Promise<InvestmentTransaction> {
    // First database statement this method makes; the rebuild at the end takes
    // the same re-entrant lock. It is *not* the first statement of the caller's
    // transaction: a split rebuild has already row-locked the parent by the time
    // it gets here, so the caller takes `lockEmbeddedInvestmentScopes` before
    // that row lock and this call then costs nothing
    // (`common/db/locks.ts`, 40P01).
    await lockHoldingScope(manager, [brokerageAccountId]);

    if (!isInvestmentActionAllowedInSplit(dto.action)) {
      throw new BadRequestException(
        tr(
          "errors.securities.actionNotAllowedInSplit",
          `Investment action ${dto.action} is not allowed inside a split transaction`,
          { action: dto.action },
        ),
      );
    }

    this.assertAccruedInterestAllowed(dto.action, dto.accruedInterest, true);

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
      InvestmentAction.RETURN_OF_CAPITAL,
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

    this.assertAcquisitionPriced(dto.action, dto.price);

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
      parentTransactionDate,
    );

    // The parent split's cash amount has to be the cash impact converted at THIS
    // rate. `validateSplits` can only check the payload against itself -- it runs
    // before the security is loaded, so it cannot know the two currencies differ
    // -- and it used to check against a default rate of 1, blessing the
    // unconverted figure. Rejecting here, before the row is written, is what
    // stops the split's cash side and its investment side describing different
    // amounts of money.
    if (splitAmount !== undefined) {
      const expected = investmentSplitCashAmount(
        dto.action,
        Number(dto.quantity ?? 0),
        Number(dto.price ?? 0),
        Number(dto.commission ?? 0),
        exchangeRate,
      );
      if (expected !== roundMoney(Number(splitAmount))) {
        throw new BadRequestException(
          tr(
            "errors.securities.embeddedSplitAmountMismatch",
            `This split records ${splitAmount}, but ${dto.action} ${dto.quantity ?? 0} @ ${dto.price ?? 0} converts to ${expected} at a rate of ${exchangeRate}. Use that amount, or state the exchange rate you meant.`,
            {
              amount: String(splitAmount),
              action: dto.action,
              quantity: String(dto.quantity ?? 0),
              price: String(dto.price ?? 0),
              expected: String(expected),
              rate: String(exchangeRate),
            },
          ),
        );
      }
    }

    const bondGuard = await beginBondWriteGuard(manager, userId, [
      dto.securityId,
    ]);
    const carried = !dto.bondInstrumentId ? (carriedSeries ?? null) : null;
    const bondInstrumentId = await resolveTransactionSeries(manager, userId, {
      securityId: dto.securityId,
      action: dto.action,
      transactionDate: parentTransactionDate,
      bondInstrumentId: carried
        ? carried.bondInstrumentId
        : dto.bondInstrumentId,
      requested: true,
      keepStored: carried !== null,
    });

    const investmentTransaction = manager.create(InvestmentTransaction, {
      userId,
      accountId: brokerageAccountId,
      securityId: dto.securityId ?? null,
      bondInstrumentId,
      fundingAccountId: null,
      transactionId: null,
      transactionSplitId: parentSplitId,
      action: dto.action,
      transactionDate: parentTransactionDate,
      quantity: dto.quantity ?? 0,
      // Null, not zero -- the same distinction `create` keeps. An action with
      // no price has an unknown cost, and stored as zero it is a free one.
      price: dto.price ?? null,
      commission: dto.commission ?? 0,
      totalAmount,
      exchangeRate,
      description: dto.description ?? null,
      status: parentStatus ?? TransactionStatus.UNRECONCILED,
    });

    const saved = await manager.save(investmentTransaction);

    await this.processTransactionEffectsInTransaction(
      manager,
      userId,
      saved,
      false,
    );

    if (saved.securityId) {
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        [{ accountId: saved.accountId, securityId: saved.securityId }],
        manager,
      );
      // A row embedded in a split oversells exactly as a free-standing one
      // does, and is refused inside the parent's transaction.
      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        manager,
        [saved.accountId],
        [saved.securityId],
      );
    }

    await bondGuard.verify([saved.id]);

    return saved;
  }

  /**
   * Tear down the cash side of an embedded investment transaction, delete the
   * row, and re-derive the position it left behind. The parent split's
   * deletion would cascade-delete this row via the FK, but the holdings
   * projection has to be taken after the row is gone, not before.
   *
   * A removal the lots of a bond-linked security cannot spare is refused here,
   * rolling the caller's whole operation back (`BondWriteGuard`, INV-BOND-007).
   * A caller that deletes the rows only to recreate them (a split replacement)
   * passes its own `bondGuard`, tracked before the first deletion and verified
   * by the caller after the recreation, so a replacement that nets out is not
   * refused half way. `touchedSecurityIds` collects the security for the
   * caller's post-commit bond price recompute (INV-BOND-005, INV-CACHE-001).
   */
  async reverseAndRemoveEmbedded(
    manager: EntityManager,
    userId: string,
    investmentTransaction: InvestmentTransaction,
    options?: {
      touchedSecurityIds?: Set<string>;
      bondGuard?: BondWriteGuard;
    },
  ): Promise<void> {
    const bondGuard =
      options?.bondGuard ??
      (await beginBondWriteGuard(manager, userId, [
        investmentTransaction.securityId,
      ]));
    await this.reverseTransactionEffectsInTransaction(
      manager,
      userId,
      investmentTransaction,
    );
    await manager.remove(investmentTransaction);

    if (investmentTransaction.securityId) {
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        [
          {
            accountId: investmentTransaction.accountId,
            securityId: investmentTransaction.securityId,
          },
        ],
        manager,
      );
      options?.touchedSecurityIds?.add(investmentTransaction.securityId);
    }

    if (!options?.bondGuard) await bondGuard.verify();
  }

  /**
   * Recompute the engine prices of the bond-linked securities among these, after
   * the commit of a split write whose embedded investment rows changed their
   * lots (INV-BOND-005, INV-CACHE-001: never inside the transaction).
   */
  async recomputeBondPricesAfterSplitWrite(
    userId: string,
    securityIds: Iterable<string>,
  ): Promise<void> {
    const ids = [...securityIds];
    if (ids.length === 0) return;
    await this.securitiesService.recomputeBondPricesAfterWrite(userId, ids);
  }

  /**
   * Carry a split parent's status onto its embedded investment rows. The
   * parent owns an embedded row's status: only the VOID boundary moves
   * anything, and a row crossing it applies or reverses its holdings effect
   * (the parent's own amount is the cash side, handled by the caller's
   * balance path). Returns the brokerage accounts whose holdings moved, for
   * the caller's post-commit invalidation -- the recalculation is not
   * dispatched from in here, because this runs inside the caller's
   * transaction and a rollback must not leave a recompute queued.
   *
   * Called from TransactionSplitService.applyParentStatusToTransferCounterparts
   * so every route a parent's status change takes (single update, dedicated
   * status endpoint, bulk update) propagates through one place.
   */
  /**
   * Advisory-lock the holding scope of every brokerage account holding an
   * embedded investment row of these split parents.
   *
   * Called by a split-status path as the first statement of its transaction,
   * before it row-locks the parent and before it row-locks `accounts` for the
   * parent's balance. `update()` reaches the same parent the other way round --
   * `lockHoldingScope`, then `updateEmbeddedSplitParent`'s `lockTransactionRow`
   * on that parent -- so an advisory lock taken between the two row locks is
   * still a deadlock for both (`common/db/locks.ts`, 40P01). The read is
   * unlocked, so it may run before the advisory lock;
   * `pg_advisory_xact_lock` is re-entrant, so calling this twice in one
   * transaction costs nothing.
   */
  async lockEmbeddedHoldingScopes(
    manager: EntityManager,
    userId: string,
    parentTransactionIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(parentTransactionIds)];
    if (ids.length === 0) return;
    const rows: { account_id: string }[] = await manager.query(
      // includes VOID rows: records read -- a crossing in either direction
      // re-derives the same position.
      `SELECT DISTINCT it.account_id
         FROM investment_transactions it
         JOIN transaction_splits ts ON ts.id = it.transaction_split_id
        WHERE it.user_id = $2
          AND ts.transaction_id = ANY($1)`,
      [ids, userId],
    );
    await lockHoldingScope(
      manager,
      rows.map((row) => row.account_id),
    );
  }

  async applyParentStatusToEmbeddedRows(
    manager: EntityManager,
    userId: string,
    parentTransactionId: string,
    newStatus: TransactionStatus,
    touchedSecurityIds?: Set<string>,
  ): Promise<Set<string>> {
    // Re-entrant with the call the split-status paths make before their first
    // balance write (`lockEmbeddedHoldingScopes`): the advisory lock must
    // precede the `accounts` row locks the parent's balance takes, and a
    // caller that forgot still cannot reach the rebuild below without it.
    await this.lockEmbeddedHoldingScopes(manager, userId, [
      parentTransactionId,
    ]);

    const affectedAccountIds = new Set<string>();

    const splits = await manager.getRepository(TransactionSplit).find({
      where: { transactionId: parentTransactionId },
      select: ["id", "kind"],
    });
    const investmentSplitIds = splits
      .filter((split) => split.kind === SplitKind.INVESTMENT)
      .map((split) => split.id);
    if (investmentSplitIds.length === 0) return affectedAccountIds;

    const isVoid = newStatus === TransactionStatus.VOID;
    const securityIds = new Set<string>();
    const scopes = new Map<string, HoldingScope>();

    const rowsBySplit: InvestmentTransaction[][] = [];
    for (const splitId of investmentSplitIds) {
      rowsBySplit.push(
        await manager.getRepository(InvestmentTransaction).find({
          // includes VOID rows: records read -- the boundary decision below is
          // exactly about the rows already on the other side.
          where: { userId, transactionSplitId: splitId },
        }),
      );
    }

    // Every security whose lots this can move is tracked before the first row
    // changes, after the holding lock above (INV-BOND-007): a void that leaves
    // a later removal uncovered, or an un-void of a row whose price is not a
    // price per bond, is refused and the parent's whole change rolls back.
    const bondGuard = createBondWriteGuard(manager, userId);
    await bondGuard.track(rowsBySplit.flat().map((row) => row.securityId));
    const changedRowIds: string[] = [];

    for (const rows of rowsBySplit) {
      for (const row of rows) {
        const wasVoid = row.status === TransactionStatus.VOID;
        if (wasVoid === isVoid) continue;

        if (isVoid) {
          // Reverse at the row's stored (active) status; the row has no cash
          // side of its own (the parent's amount is the cash side).
          await this.reverseTransactionEffectsInTransaction(
            manager,
            userId,
            row,
            { keepCashSide: true },
          );
        }
        await manager.update(InvestmentTransaction, row.id, {
          status: newStatus,
        });
        if (!isVoid) {
          row.status = newStatus;
          await this.processTransactionEffectsInTransaction(
            manager,
            userId,
            row,
            false,
          );
        }
        affectedAccountIds.add(row.accountId);
        changedRowIds.push(row.id);
        if (row.securityId) {
          securityIds.add(row.securityId);
          touchedSecurityIds?.add(row.securityId);
          scopes.set(`${row.accountId}:${row.securityId}`, {
            accountId: row.accountId,
            securityId: row.securityId,
          });
        }
      }
    }

    if (scopes.size > 0) {
      // Every row that crossed the boundary changed which ledger rows count,
      // so the positions they belong to are re-derived from the ledger before
      // the oversell check reads it.
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        Array.from(scopes.values()),
        manager,
      );
    }

    if (affectedAccountIds.size > 0) {
      // A crossing that would oversell -- voiding a BUY whose shares a later
      // SELL disposed of, un-voiding a SELL the position cannot cover -- is
      // refused here, rolling the parent's whole status change back.
      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        manager,
        Array.from(affectedAccountIds),
        securityIds.size > 0 ? Array.from(securityIds) : undefined,
      );
    }

    await bondGuard.verify(changedRowIds);

    return affectedAccountIds;
  }

  /**
   * Sync a split transaction's parent after one of its embedded investment
   * rows changes. Recomputes the split's cash-side amount from the saved
   * investment row, re-sums all sibling splits to derive the parent
   * transaction's new amount, and applies the delta to the cash account so
   * its balance stays consistent.
   */
  private async updateEmbeddedSplitParent(
    manager: EntityManager,
    userId: string,
    saved: InvestmentTransaction,
    splitId: string,
  ): Promise<void> {
    const cashImpactInSecurity = computeInvestmentCashImpact(
      saved.action,
      Number(saved.quantity ?? 0),
      Number(saved.price ?? 0),
      Number(saved.commission ?? 0),
      0,
      // The stored total, not a recomputation from the stored price: the row
      // was written from what the trade actually came to.
      Number(saved.totalAmount ?? 0),
    );
    const newSplitAmount = roundMoney(
      cashImpactInSecurity * Number(saved.exchangeRate),
    );

    const split = await manager.findOne(TransactionSplit, {
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

    // Locked first, before any write: the delta below reverses `oldParentAmount`,
    // so it has to be the version this write replaces. Two concurrent edits to
    // the same parent's splits would otherwise each apply a delta derived from
    // the same stale amount (audit P4-003).
    const parentTransaction = await lockTransactionRow(
      manager,
      split.transactionId,
      userId,
    );
    if (!parentTransaction) {
      throw new NotFoundException(
        tr(
          "errors.securities.parentTransactionNotFound",
          `Parent transaction ${split.transactionId} not found for embedded investment update`,
          { transactionId: split.transactionId },
        ),
      );
    }

    // INV-RECONCILE-001: editing an embedded investment row rewrites this split's
    // amount and the parent transaction's total, so a reconciled locked parent
    // refuses the change -- "not its fields, not its splits". Runs after the row
    // lock and before the first write, so the refusal reverses nothing. Editing
    // the split amount used to happen before the parent was even loaded, which is
    // why this had to move above that write rather than beside it.
    await assertReconciledRowsMutable(manager, userId, [parentTransaction]);
    const accrued = await manager.query(
      "SELECT id FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=$2 LIMIT 1",
      [userId, parentTransaction.id],
    );
    if (accrued.length) throw accrualErrors.historyUnsupported();

    await manager.update(TransactionSplit, splitId, {
      amount: newSplitAmount,
    });

    const siblingSplits = await manager.find(TransactionSplit, {
      where: { transactionId: split.transactionId },
    });
    const newParentAmount = sumMoney(
      siblingSplits.map((s) =>
        s.id === splitId ? newSplitAmount : Number(s.amount),
      ),
    );
    const oldParentAmount = parentTransaction.amount;
    const delta = roundMoney(newParentAmount - oldParentAmount);

    await manager.update(Transaction, parentTransaction.id, {
      amount: newParentAmount,
    });

    // A VOID parent contributed nothing to the balance, so a change to what it
    // records moves nothing either -- the delta belongs only to a parent whose
    // amount is actually in the balance.
    if (delta !== 0 && parentTransaction.status !== TransactionStatus.VOID) {
      if (isTransactionInFuture(parentTransaction.transactionDate)) {
        await this.accountsService.recalculateCurrentBalance(
          userId,
          parentTransaction.accountId,
        );
      } else {
        await this.accountsService.updateBalance(
          parentTransaction.accountId,
          delta,
        );
      }
    }
  }

  /**
   * The account ids a register query runs over: the ones asked for, plus each
   * one's linked ledger.
   *
   * An investment account is a pair, and its trades live on the brokerage half
   * while the cash they settle into lives on the other -- so a register scoped
   * to one half alone answers with part of what the user is looking at.
   * Undefined means "every account", which is what an unfiltered register asks
   * for. It is one function because the filter pickers must offer values from
   * exactly the rows the list will show.
   */
  private async resolveRegisterAccountIds(
    userId: string,
    accountIds?: string[],
  ): Promise<string[] | undefined> {
    if (!accountIds || accountIds.length === 0) return undefined;
    const resolvedIds = new Set<string>(accountIds);
    const accounts = await this.accountsService.findByIds(userId, accountIds);
    for (const acct of accounts) {
      if (acct.linkedAccountId) {
        resolvedIds.add(acct.linkedAccountId);
      }
    }
    return [...resolvedIds];
  }

  /**
   * The actions and symbols the register's rows actually use, for its filter.
   *
   * The action vocabulary is twenty-odd wide -- reinvested short-term capital
   * gains, redemptions, share transfers -- and a household brokerage uses four
   * of them. Offering all twenty as ways to narrow six rows is a list to read
   * rather than a filter to use.
   *
   * Symbols come from the rows for a sharper reason than length: the picker used
   * to be built from *current holdings*, so a position sold in full was not
   * offered -- and its trades are exactly the rows somebody filtering by symbol
   * is usually looking for. A filter offers what the list contains, not what the
   * portfolio still holds.
   *
   * Actions are returned in the enum's own order, so the picker's order is a
   * property of the vocabulary rather than of whichever action happened to be
   * traded first; symbols are alphabetical, having no such order of their own.
   */
  async getRegisterFilterOptions(
    userId: string,
    accountIds?: string[],
  ): Promise<{ actions: InvestmentAction[]; symbols: string[] }> {
    return withScopedDb(this.dataSource, async (m) => {
      // includes VOID rows: the register lists them, struck through, so the
      // picker has to offer the action and symbol of a voided row or the filter
      // cannot find it.
      const query = m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("it")
        .leftJoin("it.security", "security")
        .select("it.action", "action")
        .addSelect("security.symbol", "symbol")
        .distinct(true)
        .where("it.userId = :userId", { userId });

      const allIds = await this.resolveRegisterAccountIds(userId, accountIds);
      if (allIds) {
        query.andWhere("it.accountId IN (:...allIds)", { allIds });
      }

      const rows = await query.getRawMany<{
        action: InvestmentAction;
        symbol: string | null;
      }>();
      const usedActions = new Set(rows.map((r) => r.action));
      // A row can have no security at all -- an interest posting against the
      // cash ledger -- and a blank option is not a symbol to filter by.
      const usedSymbols = new Set(
        rows.map((r) => r.symbol).filter((s): s is string => !!s),
      );
      return {
        actions: Object.values(InvestmentAction).filter((a) =>
          usedActions.has(a),
        ),
        symbols: [...usedSymbols].sort(),
      };
    });
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

    // Count and page share one scoped transaction so the total cannot drift
    // from the rows returned beside it.
    return withScopedDb(this.dataSource, async (m) => {
      // includes VOID rows: records read -- the register lists a VOID row,
      // struck through, exactly as the cash register does.
      const query = m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("it")
        .leftJoinAndSelect("it.account", "account")
        .leftJoinAndSelect("it.security", "security")
        .leftJoinAndSelect("it.fundingAccount", "fundingAccount")
        .where("it.userId = :userId", { userId });

      // A redemption's accrued-interest companion is not its own event in the
      // register: it is shown as part of the redemption, whose single cash row
      // already carries it. Excluded from the count as well as the page, so
      // pagination cannot split a pair across two pages.
      query.andWhere(
        `NOT (it.action = :companionAction AND EXISTS (
           SELECT 1 FROM investment_transactions parent
           WHERE parent.id = it.linked_transaction_id
             AND parent.user_id = it.user_id
             AND parent.action = :redeemAction))`,
        {
          companionAction: InvestmentAction.INTEREST,
          redeemAction: InvestmentAction.REDEEM,
        },
      );

      const allIds = await this.resolveRegisterAccountIds(userId, accountIds);
      if (allIds) {
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

      await this.attachAccruedInterest(m, userId, data);
      // The unit travels with the figure: price, commission and total are the
      // security's currency, never the account's for a trade (issue #1394),
      // and the investment account's for a row that names no security, which
      // is where the write path denominated it.
      attachInvestmentRowCurrencies(data);

      return {
        data,
        pagination: buildPaginationMeta(pageNum, pageSize, total),
      };
    });
  }

  /**
   * Apply a transaction's effect on a running share balance. Calls the shared
   * reducer rather than mirroring it, so these running totals cannot drift from
   * stored holdings or from the historical net-worth replay.
   */
  private applyQuantityToBalance(
    balance: number,
    action: InvestmentAction,
    quantity: number,
  ): number {
    return applyActionToQuantity(balance, action, quantity);
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

    // includes VOID rows: records read -- the history lists a VOID row,
    // flagged; the running share balances below skip it.
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where: { userId, securityId },
        relations: ["account"],
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );

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
      // The row list is a record, so a VOID row stays visible -- but it moved
      // no shares, so the running balances skip it.
      const newBalance = investmentRowHasEffect(tx)
        ? this.applyQuantityToBalance(
            prevBalance,
            tx.action,
            Number(tx.quantity) || 0,
          )
        : prevBalance;
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
        status: tx.status,
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
      /** The realized gains that are known, whether or not the rest are. */
      realizedKnownScaled: number;
      unrealizedScaled: number;
      totalScaled: number;
      /** Set when any folded row had an unconvertible boundary value. */
      incomplete: boolean;
      /** Set when any folded row's realized gain rests on an unknown basis. */
      realizedIncomplete: boolean;
    }
    const buckets = new Map<string, Bucket>();
    let totalsRealizedScaled = 0;
    let totalsRealizedKnownScaled = 0;
    let totalsUnrealizedScaled = 0;
    let totalsCapitalScaled = 0;

    // A row whose FX could not be resolved -- or whose realized gain rests on
    // an unpriced acquisition -- contributes nothing to the sums and marks
    // them incomplete, rather than being counted as a zero-value period.
    let totalsIncomplete = false;
    let totalsRealizedIncomplete = false;

    for (const e of filtered) {
      if (e.realizedGain === null) {
        totalsRealizedIncomplete = true;
      } else {
        totalsRealizedScaled += Math.round(e.realizedGain * 10000);
      }
      totalsRealizedKnownScaled += Math.round(
        (e.realizedGain ?? e.realizedGainKnownSubtotal ?? 0) * 10000,
      );
      if (e.unrealizedGain === null || e.totalCapitalGain === null) {
        totalsIncomplete = true;
      } else {
        totalsUnrealizedScaled += Math.round(e.unrealizedGain * 10000);
        totalsCapitalScaled += Math.round(e.totalCapitalGain * 10000);
      }

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
          realizedKnownScaled: 0,
          unrealizedScaled: 0,
          totalScaled: 0,
          incomplete: false,
          realizedIncomplete: false,
        };
        buckets.set(key, b);
      }

      // Track currency: consistent → keep it; mixed → null.
      if (b.currency === undefined) {
        b.currency = e.accountCurrencyCode;
      } else if (b.currency !== e.accountCurrencyCode) {
        b.currency = null;
      }

      if (e.realizedGain === null) {
        b.realizedIncomplete = true;
      } else {
        b.realizedScaled += Math.round(e.realizedGain * 10000);
      }
      b.realizedKnownScaled += Math.round(
        (e.realizedGain ?? e.realizedGainKnownSubtotal ?? 0) * 10000,
      );
      if (
        e.startValue === null ||
        e.endValue === null ||
        e.unrealizedGain === null ||
        e.totalCapitalGain === null
      ) {
        b.incomplete = true;
      } else {
        b.startValueScaled += Math.round(e.startValue * 10000);
        b.endValueScaled += Math.round(e.endValue * 10000);
        b.unrealizedScaled += Math.round(e.unrealizedGain * 10000);
        b.totalScaled += Math.round(e.totalCapitalGain * 10000);
      }
    }

    const MAX_ENTRIES = 100;
    const allEntries: LlmCapitalGainsEntry[] = [...buckets.values()].map(
      (b) => ({
        month: b.month,
        accountName: b.accountName,
        symbol: b.symbol,
        securityName: b.securityName,
        currency: b.currency ?? null,
        startValue: b.incomplete
          ? null
          : roundMoney(b.startValueScaled / 10000),
        endValue: b.incomplete ? null : roundMoney(b.endValueScaled / 10000),
        realizedGain: b.realizedIncomplete
          ? null
          : roundMoney(b.realizedScaled / 10000),
        realizedGainComplete: !b.realizedIncomplete,
        realizedGainKnownSubtotal: b.realizedIncomplete
          ? roundMoney(b.realizedKnownScaled / 10000)
          : null,
        unrealizedGain: b.incomplete
          ? null
          : roundMoney(b.unrealizedScaled / 10000),
        totalCapitalGain: b.incomplete
          ? null
          : roundMoney(b.totalScaled / 10000),
      }),
    );
    allEntries.sort((a, b) => {
      if (groupBy === "month")
        return (a.month ?? "").localeCompare(b.month ?? "");
      // Unknown sorts last rather than as zero.
      return (
        (b.totalCapitalGain ?? -Infinity) - (a.totalCapitalGain ?? -Infinity)
      );
    });

    return {
      startDate: options.startDate,
      endDate: options.endDate,
      totals: {
        realizedGain: totalsRealizedIncomplete
          ? null
          : roundMoney(totalsRealizedScaled / 10000),
        realizedGainComplete: !totalsRealizedIncomplete,
        realizedGainKnownSubtotal: totalsRealizedIncomplete
          ? roundMoney(totalsRealizedKnownScaled / 10000)
          : null,
        unrealizedGain: totalsIncomplete
          ? null
          : roundMoney(totalsUnrealizedScaled / 10000),
        totalCapitalGain: totalsIncomplete
          ? null
          : roundMoney(totalsCapitalScaled / 10000),
      },
      groupedBy: groupBy,
      entries: allEntries.slice(0, MAX_ENTRIES),
      entryCount: allEntries.length,
      truncatedEntryList: allEntries.length > MAX_ENTRIES,
    };
  }

  async findOne(userId: string, id: string): Promise<InvestmentTransaction> {
    // includes VOID rows: records read -- a VOID row is still viewable.
    const transaction = await withScopedDb(this.dataSource, async (m) => {
      const row = await m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("it")
        .leftJoinAndSelect("it.account", "account")
        .leftJoinAndSelect("it.security", "security")
        .leftJoinAndSelect("it.fundingAccount", "fundingAccount")
        .where("it.id = :id", { id })
        .andWhere("it.userId = :userId", { userId })
        .getOne();
      if (row) await this.attachAccruedInterest(m, userId, [row]);
      return row;
    });

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

    await withScopedDb(this.dataSource, async (manager) => {
      // First statement of the transaction: the holdings lock on every account
      // the pair leaves or joins, before anything is validated or written --
      // the edit used to take it only inside its closing rebuild, so it checked
      // the oversell without seeing a concurrent SELL and both committed
      // (A26-L19). Then both legs under their row locks: a leg another request
      // changed or deleted since the read above is refused before any write.
      await lockHoldingScope(
        manager,
        [
          editedLeg.accountId,
          linkedLeg.accountId,
          updateDto.accountId,
          updateDto.destinationAccountId,
        ].filter((id): id is string => !!id),
      );
      for (const leg of [editedLeg, linkedLeg].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        await lockUnchangedInvestmentRow(manager, userId, leg);
      }

      const bondGuard = await beginBondWriteGuard(manager, userId, [
        editedLeg.securityId,
        updateDto.securityId,
      ]);
      // The series both legs carry (INV-BOND-007), refused before the reversal
      // writes anything; only a value that differs from the stored one is a
      // request (a form resends it on every save), and an edit that changes
      // neither the security, the date nor the series keeps the stored value.
      const bondInstrumentId = await resolveTransactionSeries(manager, userId, {
        keepStored: keepsStoredSeries(editedLeg, updateDto),
        securityId:
          updateDto.securityId !== undefined
            ? updateDto.securityId
            : editedLeg.securityId,
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: updateDto.transactionDate ?? editedLeg.transactionDate,
        bondInstrumentId:
          updateDto.bondInstrumentId !== undefined
            ? updateDto.bondInstrumentId
            : editedLeg.bondInstrumentId,
        requested:
          updateDto.bondInstrumentId !== undefined &&
          updateDto.bondInstrumentId !== null &&
          updateDto.bondInstrumentId !== editedLeg.bondInstrumentId,
      });

      // Reverse both legs at their original values before reapplying.
      await this.reverseTransactionEffectsInTransaction(
        manager,
        userId,
        editedLeg,
      );
      await this.reverseTransactionEffectsInTransaction(
        manager,
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

      // Status: applied to the edited leg; the pair shares only the VOID
      // boundary (two rows describing one movement of shares), while
      // reconciliation states stay per-leg. The reversal above keyed on each
      // leg's OLD status and the reapplication below keys on the new one, so
      // a crossing moves both legs' holdings and a non-crossing change moves
      // neither.
      if (updateDto.status !== undefined) {
        const crossesVoid =
          (editedLeg.status === TransactionStatus.VOID) !==
          (updateDto.status === TransactionStatus.VOID);
        editedLeg.status = updateDto.status;
        if (crossesVoid) {
          linkedLeg.status = updateDto.status;
        }
      }

      // Shared fields applied to both legs.
      const applyShared = (leg: InvestmentTransaction) => {
        leg.bondInstrumentId = bondInstrumentId;
        if (updateDto.securityId !== undefined) {
          leg.securityId = updateDto.securityId || null;
          leg.security = updateDto.securityId
            ? ({ id: updateDto.securityId } as any)
            : (null as any);
        }
        if (updateDto.quantity !== undefined) leg.quantity = updateDto.quantity;
        // `updateDto.price` is deliberately not applied: a transfer leg's price
        // is the basis the source released, recomputed from the ledger below
        // (A26-M22), never a figure the client sends.
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

      const savedEdited = await manager.save(editedLeg);
      const savedLinked = await manager.save(linkedLeg);

      await this.processTransactionEffectsInTransaction(
        manager,
        userId,
        savedEdited,
        false,
      );
      await this.processTransactionEffectsInTransaction(
        manager,
        userId,
        savedLinked,
        false,
      );

      // Both legs carry the basis the (new) OUT leg relieves at its position in
      // the replay, now that the shared fields are saved (A26-M22). A date or
      // quantity edit moves that position, so the old price would be stale; a
      // source that does not hold the units on the date keeps the stored price
      // and the negative-holdings check below refuses the edit.
      const carriedPerShare = outLeg.securityId
        ? await this.holdingsService.releasedBasisPerShare(
            userId,
            outLeg.securityId,
            outLeg.id,
            manager,
          )
        : null;
      if (carriedPerShare !== null) {
        const carriedCost = roundToDecimals(
          carriedPerShare,
          INVESTMENT_PRICE_DECIMALS,
        );
        await manager.update(InvestmentTransaction, [outLeg.id, inLeg.id], {
          price: carriedCost,
        });
        outLeg.price = carriedCost;
        inLeg.price = carriedCost;
      }

      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        manager,
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
        manager,
      );

      await bondGuard.verify([editedLeg.id, linkedLeg.id]);
    });

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

  /**
   * Change only the status, without touching the financial rows: the register's
   * click-to-cycle path. UNRECONCILED/CLEARED/RECONCILED move nothing but the
   * column; crossing the VOID boundary applies or reverses the row's holdings
   * effect and carries the existing cash leg (and a linked transfer leg) across
   * with it -- the leg is flipped in place, not deleted and recreated, because
   * a status change is not an edit of the financial rows.
   *
   * Everything -- the status the transition is decided from, the refusals, the
   * holdings move, the oversell validation -- runs inside one transaction under
   * a row lock, so a refusal leaves nothing written (contract section 7).
   */
  /**
   * The brokerage accounts a status change on this row can re-derive: the
   * row's own and its linked transfer leg's.
   *
   * Read without a lock on purpose. The advisory lock has to be the
   * transaction's first lock, so the ids it is given cannot come from a row
   * lock; a row that moved account between this read and the lock loses only
   * a lock it never needed, exactly as `remove()`'s pre-read does.
   */
  private async readStatusHoldingScopeAccountIds(
    manager: EntityManager,
    userId: string,
    id: string,
  ): Promise<string[]> {
    const rows: { account_id: string }[] = await manager.query(
      // includes VOID rows: records read -- the scope of a crossing is the
      // same whichever side of the boundary the row is on.
      `SELECT DISTINCT account_id
         FROM investment_transactions
        WHERE user_id = $2
          AND (id = $1
               OR id = (SELECT linked_transaction_id
                          FROM investment_transactions
                         WHERE id = $1 AND user_id = $2))`,
      [id, userId],
    );
    return rows.map((row) => row.account_id);
  }

  async updateStatus(
    userId: string,
    id: string,
    newStatus: TransactionStatus,
  ): Promise<InvestmentTransaction> {
    const outcome = await withScopedDb(this.dataSource, async (manager) => {
      // First lock of the transaction: advisory before row locks
      // (`common/db/locks.ts`). The scope ids come from an unlocked read --
      // a plain `SELECT` takes no lock, so it may precede the advisory one --
      // covering this row and the transfer leg that crosses the VOID boundary
      // with it. The rebuild at the end takes the same re-entrant lock, and
      // `applyVoidTransitionToMirrorLeg` below row-locks `accounts`; taking
      // the advisory lock only inside the rebuild put those two in the
      // opposite order from every other investment write (40P01).
      await lockHoldingScope(
        manager,
        await this.readStatusHoldingScopeAccountIds(manager, userId, id),
      );

      const locked = await lockInvestmentTransactionRow(manager, id, userId);
      if (!locked) {
        throw new NotFoundException(
          tr(
            "errors.securities.investmentTransactionNotFound",
            `Investment transaction with ID ${id} not found`,
            { id },
          ),
        );
      }

      if (locked.status === newStatus) {
        return {
          affectedAccountIds: new Set<string>(),
          splitTouched: false,
          securityIds: [] as string[],
        };
      }

      // The parent split transaction owns an embedded row's status; see
      // update() for the same refusal on the generic edit path.
      if (locked.transactionSplitId) {
        throw new BadRequestException(
          tr(
            "errors.securities.embeddedStatusLocked",
            "This investment transaction is part of a split transaction. Change the split transaction's status instead, so both sides change together.",
          ),
        );
      }

      const wasVoid = locked.status === TransactionStatus.VOID;
      const isVoid = newStatus === TransactionStatus.VOID;

      if (wasVoid === isVoid) {
        // Purely presentational: only crossing the VOID boundary moves money
        // or shares.
        await manager.update(InvestmentTransaction, id, { status: newStatus });
        return {
          affectedAccountIds: new Set<string>(),
          splitTouched: false,
          securityIds: [] as string[],
        };
      }

      // Crossing. A linked transfer leg is the same movement of shares, so it
      // crosses with this row; a leg already on the target side is left alone.
      const legs: LockedInvestmentTransactionRow[] = [locked];
      if (locked.linkedTransactionId) {
        const linkedLeg = await lockInvestmentTransactionRow(
          manager,
          locked.linkedTransactionId,
          userId,
        );
        if (
          linkedLeg &&
          (linkedLeg.status === TransactionStatus.VOID) !== isVoid
        ) {
          legs.push(linkedLeg);
        }
      }

      // Voiding an acquisition (or restoring a removal) can leave a removal
      // uncovered: refused after the mutation, in this transaction
      // (INV-BOND-007).
      const bondGuard = await beginBondWriteGuard(
        manager,
        userId,
        legs.map((leg) => leg.securityId),
      );

      const affectedAccountIds = new Set<string>();
      const securityIds = new Set<string>();
      const scopes = new Map<string, HoldingScope>();
      let splitTouched = false;

      for (const leg of legs) {
        affectedAccountIds.add(leg.accountId);
        if (leg.securityId) {
          securityIds.add(leg.securityId);
          scopes.set(`${leg.accountId}:${leg.securityId}`, {
            accountId: leg.accountId,
            securityId: leg.securityId,
          });
        }
        // No quantity is folded here -- a crossing on a SPLIT row is followed
        // by a full rebuildFromTransactions after commit, same as
        // create()/update(); this only remembers that one was touched.
        splitTouched =
          splitTouched || leg.action === (InvestmentAction.SPLIT as string);

        if (isVoid) {
          // Reverse the holdings effect at the leg's stored (active) status,
          // leaving the cash row in place -- it crosses the boundary below.
          await this.reverseTransactionEffectsInTransaction(
            manager,
            userId,
            leg as unknown as InvestmentTransaction,
            { keepCashSide: true },
          );
        }

        await manager.update(InvestmentTransaction, leg.id, {
          status: newStatus,
        });

        if (!isVoid) {
          // Apply the holdings effect under the new (active) status; the cash
          // row already exists, so no cash side is created here.
          const activeLeg = {
            ...leg,
            status: newStatus,
          } as unknown as InvestmentTransaction;
          await this.processTransactionEffectsInTransaction(
            manager,
            userId,
            activeLeg,
            false,
          );
        }

        // The cash leg shares the VOID boundary: same helper, same rules
        // (adjusted by its own amount; future-dated resolves by recalculation)
        // as a transfer's mirror leg.
        if (leg.transactionId) {
          const cashAccountIds = await applyVoidTransitionToMirrorLeg(
            manager,
            this.accountsService,
            userId,
            { linkedTransactionId: leg.transactionId },
            newStatus,
          );
          for (const accountId of cashAccountIds) {
            affectedAccountIds.add(accountId);
          }
        }
      }

      // The crossing changed which rows count, so each touched position is
      // re-derived from the ledger inside this transaction.
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        Array.from(scopes.values()),
        manager,
      );

      // A crossing that would oversell is refused, rolling everything above
      // back: a rejected command must not already have written.
      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        manager,
        Array.from(affectedAccountIds),
        securityIds.size > 0 ? Array.from(securityIds) : undefined,
      );

      await bondGuard.verify(legs.map((leg) => leg.id));

      return {
        affectedAccountIds,
        splitTouched,
        securityIds: Array.from(securityIds),
      };
    });

    // SPLIT mutations compound on holding state, so a boundary crossing on one
    // is followed by a full rebuild -- same rule as create()/update().
    if (outcome.splitTouched) {
      await this.holdingsService
        .rebuildFromTransactions(userId)
        .catch((err) =>
          this.logger.warn(
            `Holdings rebuild after SPLIT status change failed: ${err.message}`,
          ),
        );
    }

    for (const accountId of outcome.affectedAccountIds) {
      this.triggerRecalcWithCashAccount(accountId, userId);
    }

    // A VOID crossing changes which rows count, hence the lots of a linked bond.
    await this.securitiesService.recomputeBondPricesAfterWrite(
      userId,
      outcome.securityIds,
    );

    return this.findOne(userId, id);
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
      const linkedLeg = await withScopedDb(this.dataSource, (m) =>
        // includes VOID rows: records read -- the paired leg is loaded
        // whatever its status.
        m.getRepository(InvestmentTransaction).findOne({
          where: { id: transaction.linkedTransactionId!, userId },
        }),
      );
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
      const updatedLeg = await this.updateLinkedTransfer(
        userId,
        transaction,
        linkedLeg,
        updateDto,
      );
      // A pair edit moves the quantity, the date or the accounts of both legs.
      await this.securitiesService.recomputeBondPricesAfterWrite(userId, [
        transaction.securityId,
        updatedLeg.securityId,
      ]);
      return updatedLeg;
    }

    // The companion is materialized from its redemption's accrued interest, so
    // editing it directly would be overwritten by the next edit of the pair --
    // and its amount is the one the single cash row was built from.
    if (
      transaction.action === InvestmentAction.INTEREST &&
      transaction.linkedTransactionId
    ) {
      const partner = await withScopedDb(this.dataSource, (m) =>
        // includes VOID rows: records read -- the partner is loaded whatever
        // its status, to decide whether this row is a companion at all.
        m.getRepository(InvestmentTransaction).findOne({
          where: { id: transaction.linkedTransactionId!, userId },
        }),
      );
      if (partner && isAccruedInterestCompanion(transaction, partner)) {
        throw new BadRequestException(
          tr(
            "errors.securities.accruedInterestCompanionLocked",
            "This interest row records the accrued interest of a redemption. Edit the redemption's accrued interest instead, so both sides change together.",
          ),
        );
      }
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
      // The parent split transaction owns an embedded row's status: the
      // parent's amount is the cash side of this event, so the row crossing
      // the VOID boundary alone would leave the pair describing two different
      // events. Keyed on the value differing, not on the field being present
      // -- the form resends the current status on every save.
      if (
        updateDto.status !== undefined &&
        updateDto.status !== transaction.status
      ) {
        throw new BadRequestException(
          tr(
            "errors.securities.embeddedStatusLocked",
            "This investment transaction is part of a split transaction. Change the split transaction's status instead, so both sides change together.",
          ),
        );
      }
    }

    // The row as stored, read before any assignment below moves it. The
    // acquisition guard compares against these rather than against which fields
    // the DTO happened to carry; see the guard's own comment.
    const priorAction = transaction.action;
    const priorPrice = transaction.price;
    // Read here for the same reason: what re-derives the stored total is a
    // value difference in the fields the total is made of, never the mere
    // presence of a field the form resends on every save.
    const priorQuantity = transaction.quantity;
    const priorCommission = transaction.commission;
    const priorTotalAmount = transaction.totalAmount;

    const savedId = await withScopedDb(this.dataSource, async (manager) => {
      // First statement of the transaction: advisory before row locks
      // (`common/db/locks.ts`). Both the account the row leaves and the one it
      // joins, because the rebuild at the end covers both.
      await lockHoldingScope(
        manager,
        [accountId, updateDto.accountId].filter((id): id is string => !!id),
      );
      // Everything below is derived from the row read before this transaction
      // (the cash row the reversal deletes, the values the save writes back),
      // so it has to still be the row as it is now: a concurrent edit or delete
      // is refused before anything is written (A26-H04).
      await lockUnchangedInvestmentRow(manager, userId, transaction);

      const bondGuard = await beginBondWriteGuard(manager, userId, [
        oldSecurityId,
        updateDto.securityId,
      ]);

      // The series the row will carry (INV-BOND-007), resolved against the row
      // as it will be and refused before the reversal writes anything. A form
      // resends the stored series on every save, so only a value that differs
      // from the stored one is a request; an edit that changes neither the
      // series, the security, the action nor the date keeps the stored value
      // as it is (NULL included); otherwise the stored one is kept, and dropped
      // when the row can no longer carry it (relinked, unlinked, a cash action).
      const bondInstrumentId = await resolveTransactionSeries(manager, userId, {
        keepStored: keepsStoredSeries(transaction, updateDto),
        securityId:
          updateDto.securityId !== undefined
            ? updateDto.securityId
            : transaction.securityId,
        action: updateDto.action ?? transaction.action,
        transactionDate:
          updateDto.transactionDate ?? transaction.transactionDate,
        bondInstrumentId:
          updateDto.bondInstrumentId !== undefined
            ? updateDto.bondInstrumentId
            : transaction.bondInstrumentId,
        requested:
          updateDto.bondInstrumentId !== undefined &&
          updateDto.bondInstrumentId !== null &&
          updateDto.bondInstrumentId !== transaction.bondInstrumentId,
      });

      // Resolved before the reversal, while the row still carries its stored
      // action: an edit may take the action away from REDEEM, and the companion
      // still has to be found so it can be refused or removed.
      const existingCompanion = await this.findAccruedInterestCompanion(
        manager,
        userId,
        transaction,
      );
      // Keyed on the value, not on the field being present: the form resends
      // the whole row on every save, so an omitted field means "unchanged"
      // rather than "cleared".
      const accruedInterest = roundMoney(
        updateDto.accruedInterest !== undefined
          ? Number(updateDto.accruedInterest)
          : Number(existingCompanion?.totalAmount ?? 0),
      );
      this.assertAccruedInterestAllowed(
        updateDto.action ?? transaction.action,
        accruedInterest,
        isEmbedded,
      );

      // Reverse the original transaction effects
      await this.reverseTransactionEffectsInTransaction(
        manager,
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
          InvestmentAction.RETURN_OF_CAPITAL,
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
      transaction.bondInstrumentId = bondInstrumentId;
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
      // The reversal above ran against the stored (old) status, so a VOID row
      // undid nothing; the reapplication below runs against the new one, so an
      // edit that crosses the boundary composes from the same two halves as
      // every other edit.
      if (updateDto.status !== undefined) transaction.status = updateDto.status;

      // What the executed total is made of, compared by VALUE against the row
      // as it was stored. `InvestmentTransactionForm` resends every field, so
      // a presence-keyed re-derivation recomputed `total_amount` from the
      // stored price on a description-only edit -- and a price is a rounded
      // quotient, so a sale entered at its statement total of 820.9100 came
      // back as 141 x 5.82 = 820.6200.
      const quantityChanged =
        updateDto.quantity !== undefined &&
        Number(updateDto.quantity) !== Number(priorQuantity ?? 0);
      const priceChanged =
        updateDto.price !== undefined &&
        Number(updateDto.price) !== Number(priorPrice ?? 0);
      const commissionChanged =
        updateDto.commission !== undefined &&
        Number(updateDto.commission) !== Number(priorCommission ?? 0);
      const totalChanged =
        updateDto.totalAmount !== undefined &&
        Number(updateDto.totalAmount) !== Number(priorTotalAmount ?? 0);

      if (totalChanged) {
        // The caller stated what the trade actually came to. That is the fact;
        // the price follows it -- unless the caller changed the price in the
        // same edit and the two already agree, in which case nothing is lost
        // by keeping the price exactly as sent.
        const amounts = resolveInvestmentAmounts({
          action: transaction.action,
          quantity: transaction.quantity,
          price: priceChanged ? transaction.price : null,
          commission: transaction.commission,
          totalAmount: updateDto.totalAmount,
        });
        transaction.totalAmount = amounts.totalAmount;
        if (amounts.price !== null) transaction.price = amounts.price;
      } else if (
        quantityChanged ||
        priceChanged ||
        commissionChanged ||
        // A different action puts the commission on the other side of the
        // total, so the row's figure is no longer the one it was stored with.
        transaction.action !== priorAction
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

      // Checked against the row as it will be, after the assignments above, so
      // changing either half is covered: setting an existing purchase's price
      // to zero, and turning an unpriced action into a `BUY` without giving it
      // one. Without this, `create` could refuse a free acquisition and
      // `update` would put one back a moment later.
      //
      // Only when the edit is what makes the row an unpriced acquisition. A row
      // that was already unpriced stays editable in every other respect -- an
      // unrelated change to its description is not the write that made it
      // wrong, and refusing it would strand rows that predate this rule with
      // no way to correct anything at all.
      //
      // That carve-out has to key on the *change*, not on which fields the DTO
      // carried. `InvestmentTransactionForm` always sends `action`, and loads a
      // legacy blank price as `0` and sends that back, so presence-keyed it
      // fired on every edit of a pre-guard zero-price BUY -- including a
      // description-only one -- which is precisely the stranding it exists to
      // avoid. Two changes are the row's own fault and nothing else is: turning
      // some other action into a priced acquisition, and taking a price that was
      // positive away. Switching such a row to `ADD_SHARES` stays open, which is
      // the honest correction for shares whose cost is unknown.
      const actionChanged = transaction.action !== priorAction;
      const priceWithdrawn =
        Number(priorPrice) > 0 && !(Number(transaction.price) > 0);
      if (actionChanged || priceWithdrawn) {
        this.assertAcquisitionPriced(transaction.action, transaction.price);
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
            transaction.transactionDate,
          );
        }
      }

      const saved = await manager.save(transaction);

      await this.syncAccruedInterestCompanion(
        manager,
        userId,
        saved,
        accruedInterest,
        existingCompanion,
      );

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
        manager,
        userId,
        saved,
        !isEmbedded,
        accruedInterest,
      );

      if (isEmbedded) {
        await this.updateEmbeddedSplitParent(
          manager,
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

      // Both the position the row left and the one it joined are re-derived
      // from the ledger, now that the row carries its new values. An
      // incremental reverse-then-reapply subtracted a delta from an average
      // cost that had been blended in a different order, so editing a
      // back-dated row left the stored figure disagreeing with the replay.
      const editedScopes = new Map<string, HoldingScope>();
      if (oldSecurityId) {
        editedScopes.set(`${accountId}:${oldSecurityId}`, {
          accountId,
          securityId: oldSecurityId,
        });
      }
      if (saved.securityId) {
        editedScopes.set(`${saved.accountId}:${saved.securityId}`, {
          accountId: saved.accountId,
          securityId: saved.securityId,
        });
      }
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        Array.from(editedScopes.values()),
        manager,
      );

      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        manager,
        affectedAccountIds,
        affectedSecurityIds.length > 0 ? affectedSecurityIds : undefined,
      );

      await bondGuard.verify([saved.id]);

      return saved.id;
    });

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
      transaction.status !== TransactionStatus.VOID &&
      InvestmentTransactionsService.PRICE_ACTIONS.has(newAction)
    ) {
      // A VOID trade's price is not a settled observation.
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

    // The lots of the old and of the new security both changed.
    await this.securitiesService.recomputeBondPricesAfterWrite(userId, [
      oldSecurityId,
      newSecurityId,
    ]);

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

  /**
   * Tear down the linked cash Transaction of an investment row that is about to
   * change or disappear.
   *
   * It does NOT touch holdings, and it must not: it runs BEFORE the ledger row
   * is re-saved (update) or removed (remove), so a rebuild here would read a
   * ledger that still contains the old row. Holdings are re-derived by the
   * caller once the ledger write is final, through
   * `HoldingsService.rebuildScopesFromTransactions` over the old and new
   * (account, security) scopes -- which is also what makes reversing a
   * back-dated row converge, instead of subtracting a delta from an average
   * cost that was blended in a different order (issue #1388).
   */
  private async reverseTransactionEffectsInTransaction(
    manager: EntityManager,
    userId: string,
    transaction: InvestmentTransaction,
    options?: {
      /**
       * Leave the linked cash Transaction row in place. Used by updateStatus,
       * which flips the existing cash leg across the VOID boundary instead of
       * deleting and recreating it -- a status change is not an edit of the
       * financial rows.
       */
      keepCashSide?: boolean;
    },
  ): Promise<void> {
    // Cash transactions are created for future-dated investments too (they show
    // as projected entries in the cash account ledger), so the linked
    // Transaction is torn down whatever the date.
    const { transactionId } = transaction;

    if (transactionId && !options?.keepCashSide) {
      // Clear the FK reference BEFORE deleting the cash transaction
      await manager.update(InvestmentTransaction, transaction.id, {
        transactionId: null,
      });
      transaction.transactionId = null;
      await this.deleteCashTransactionInTransaction(
        manager,
        userId,
        transactionId,
      );
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const transaction = await this.findOne(userId, id);
    const beforeData: Record<string, unknown> = { ...transaction };
    const { accountId } = transaction;

    // Capture linked cash transaction for undo support
    if (transaction.transactionId) {
      const cashTx = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Transaction).findOne({
          where: { id: transaction.transactionId!, userId },
        }),
      );
      if (cashTx) {
        beforeData.linkedCashTransaction = { ...cashTx };
      }
    }

    // A security transfer is two linked legs (TRANSFER_OUT <-> TRANSFER_IN).
    // Deleting either one removes the whole transfer so holdings can't be
    // left half-moved.
    const linkedLeg = transaction.linkedTransactionId
      ? await withScopedDb(this.dataSource, (m) =>
          // includes VOID rows: records read -- the paired leg is loaded
          // whatever its status.
          m.getRepository(InvestmentTransaction).findOne({
            where: { id: transaction.linkedTransactionId!, userId },
          }),
        )
      : null;
    if (linkedLeg && isAccruedInterestCompanion(transaction, linkedLeg)) {
      throw new BadRequestException(
        tr(
          "errors.securities.accruedInterestCompanionLocked",
          "This interest row records the accrued interest of a redemption. Edit the redemption's accrued interest instead, so both sides change together.",
        ),
      );
    }
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

    await withScopedDb(this.dataSource, async (manager) => {
      // First statement of the transaction: advisory before row locks
      // (`common/db/locks.ts`); the reversals below row-lock `accounts`.
      await lockHoldingScope(manager, affectedAccountIds);
      // Each leg is removed with the cash row it carries now, so it must still
      // be the row read above: a delete behind a concurrent edit would reverse
      // a cash row the edit already replaced and leave the new one without an
      // owner (A26-H04). Ascending id, so two deletes of one pair queue.
      for (const leg of [...legsToRemove].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        await lockUnchangedInvestmentRow(manager, userId, leg);
      }

      // Deleting an acquisition can leave a later removal uncovered: refused
      // after the mutation, in this transaction, so nothing commits
      // (INV-BOND-007).
      const bondGuard = await beginBondWriteGuard(
        manager,
        userId,
        affectedSecurityIds,
      );

      // Break the mutual link before deleting so neither row's FK points at a
      // row that is about to disappear.
      for (const leg of legsToRemove) {
        if (leg.linkedTransactionId) {
          await manager.update(InvestmentTransaction, leg.id, {
            linkedTransactionId: null,
          });
          leg.linkedTransactionId = null;
        }
      }

      for (const leg of legsToRemove) {
        await this.reverseTransactionEffectsInTransaction(manager, userId, leg);
        await manager.remove(leg);
      }

      // Taken AFTER the rows are gone: the position each deleted leg belonged
      // to is whatever the remaining ledger says, not the stored figure minus
      // this row's delta.
      await this.holdingsService.rebuildScopesFromTransactions(
        userId,
        legsToRemove
          .filter((leg) => leg.securityId)
          .map((leg) => ({
            accountId: leg.accountId,
            securityId: leg.securityId!,
          })),
        manager,
      );

      await this.holdingsService.validateNoNegativeHoldingsHistory(
        userId,
        manager,
        affectedAccountIds,
        affectedSecurityIds.length > 0 ? affectedSecurityIds : undefined,
      );

      await bondGuard.verify();
    });

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

    await this.securitiesService.recomputeBondPricesAfterWrite(userId, [
      transaction.securityId,
    ]);

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
    // includes VOID rows: records read -- the model sees a VOID row, flagged;
    // the sums and group folds below skip it.
    const rows = await withScopedDb(this.dataSource, async (m) => {
      const query = m
        .getRepository(InvestmentTransaction)
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

      return query
        .orderBy("it.transactionDate", "DESC")
        .addOrderBy("it.createdAt", "DESC")
        .getMany();
    });

    // round4 here is reserved for per-share prices (4dp price precision);
    // monetary amounts use the shared roundMoney, quantities use round8 (1e-8).
    const round4 = (n: number): number => Math.round(n * 10000) / 10000;
    const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

    let totalAmountScaled = 0;
    let totalCommissionScaled = 0;
    let totalQuantityScaled = 0;
    const incomeScaledByCurrency = new Map<string, number>();
    const actionCounts: Record<string, number> = {};

    for (const r of rows) {
      // Rows as effects for the sums: a VOID row is listed below, flagged, but
      // moved no money or shares, so it joins no total.
      if (!investmentRowHasEffect(r)) continue;
      totalAmountScaled += Math.round(Number(r.totalAmount) * 10000);
      addIncomeScaled(incomeScaledByCurrency, r);
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
        incomeAmount: roundMoney(investmentIncomeAmount(r)),
        incomeCurrency: llmIncomeCurrency(r),
        currency: r.account?.currencyCode ?? null,
        description: r.description ?? null,
        status: r.status,
      }));

    let groups: LlmInvestmentTxGroup[] | null = null;
    if (options.groupBy) {
      const buckets = new Map<
        string,
        {
          amountScaled: number;
          commissionScaled: number;
          quantityScaled: number;
          incomeScaled: Map<string, number>;
          count: number;
        }
      >();
      for (const r of rows) {
        if (!investmentRowHasEffect(r)) continue;
        const key = this.getLlmInvestmentGroupKey(r, options.groupBy);
        const b = buckets.get(key) ?? {
          amountScaled: 0,
          commissionScaled: 0,
          quantityScaled: 0,
          incomeScaled: new Map<string, number>(),
          count: 0,
        };
        b.amountScaled += Math.round(Number(r.totalAmount) * 10000);
        addIncomeScaled(b.incomeScaled, r);
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
          incomeByCurrency: incomeByCurrencyOf(b.incomeScaled),
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
      incomeByCurrency: incomeByCurrencyOf(incomeScaledByCurrency),
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
    const transactions = await withScopedDb(this.dataSource, async (m) => {
      // Rows as effects: the counts and money sums are what happened, and a
      // VOID transaction did not happen.
      const query = m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("it")
        .where("it.userId = :userId", { userId })
        .andWhere("it.status != 'VOID'");

      if (accountIds && accountIds.length > 0) {
        const resolvedIds = new Set<string>(accountIds);
        const accounts = await this.accountsService.findByIds(
          userId,
          accountIds,
        );
        for (const acct of accounts) {
          if (acct.linkedAccountId) {
            resolvedIds.add(acct.linkedAccountId);
          }
        }
        const allIds = [...resolvedIds];
        query.andWhere("it.accountId IN (:...allIds)", { allIds });
      }

      return query.getMany();
    });

    const incomeOfKind = (kind: InvestmentAction): number => {
      const amounts: number[] = [];
      for (const t of transactions) {
        const recorded = incomeKind(t.action);
        if (recorded !== null && baseInvestmentAction(recorded) === kind) {
          amounts.push(investmentIncomeAmount(t));
        }
      }
      return sumMoney(amounts);
    };

    const summary = {
      totalTransactions: transactions.length,
      totalBuys: transactions.filter((t) => t.action === InvestmentAction.BUY)
        .length,
      // Base-normalized so a CD/bond redemption counts as the sale it is, and
      // the short/long-term gain distributions land in the gains total.
      totalSells: transactions.filter(
        (t) => baseInvestmentAction(t.action) === InvestmentAction.SELL,
      ).length,
      // Income by kind, whether it was paid in cash or reinvested in shares.
      totalDividends: incomeOfKind(InvestmentAction.DIVIDEND),
      totalInterest: incomeOfKind(InvestmentAction.INTEREST),
      totalCapitalGains: incomeOfKind(InvestmentAction.CAPITAL_GAIN),
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
    let deletedSecurityIds: Array<string | null> = [];
    const outcome = await withScopedDb(this.dataSource, async (manager) => {
      // includes VOID rows: records read -- every row is being deleted, and
      // the per-row balance reversal below already reverses only what each
      // cash leg actually contributed.
      const transactions = await manager.find(InvestmentTransaction, {
        where: { userId },
      });
      const transactionsDeleted = transactions.length;
      deletedSecurityIds = transactions.map((t) => t.securityId);

      // Delete linked cash transactions and reverse their balance effects
      const linkedCashTxIds = transactions
        .map((t) => t.transactionId)
        .filter((id): id is string => !!id);

      if (linkedCashTxIds.length > 0) {
        // Locked in ascending id order before their amounts become reversals.
        const cashTransactions = await lockTransactionRows(
          manager,
          linkedCashTxIds,
          userId,
        );

        for (const cashTx of cashTransactions.values()) {
          const removed = await manager.delete(Transaction, {
            id: cashTx.id,
            userId,
          });
          if ((removed.affected ?? 0) === 0) continue;
          // Guarded VOID but not future-dated -- the mirror image of RR4-001,
          // found by the scanning guard. A future-dated cash leg was never folded
          // into the balance either, so reversing it moved money that was never
          // there.
          const effect = deletionBalanceEffect(cashTx);
          if (effect.delta !== 0) {
            await this.accountsService.updateBalance(
              cashTx.accountId,
              effect.delta,
            );
          }
          if (effect.needsRecalc) {
            await this.accountsService.recalculateCurrentBalance(
              userId,
              cashTx.accountId,
            );
          }
        }
      }

      if (transactions.length > 0) {
        await manager.remove(transactions);
      }

      const holdingsResult =
        await this.holdingsService.removeAllForUser(userId);

      const accountsReset =
        await this.accountsService.resetBrokerageBalances(userId);

      return {
        transactionsDeleted,
        holdingsDeleted: holdingsResult,
        accountsReset,
      };
    });
    // No lots are left on any linked bond: its engine rows go.
    await this.securitiesService.recomputeBondPricesAfterWrite(
      userId,
      deletedSecurityIds,
    );
    return outcome;
  }
}
