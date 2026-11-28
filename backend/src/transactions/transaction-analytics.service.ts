import {
  type CategoryHolder,
  categoryFits,
  transferCategoryRefusal,
} from "../categories/category-fit";
import { Injectable, Logger } from "@nestjs/common";
import {
  type CategoryType,
  categoryTypeIs,
  categoryTypeOf,
  isCategoryType,
  isTransferCategory,
} from "../categories/category-type.util";
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  SelectQueryBuilder,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import {
  applyInvestmentTransactionFilters,
  brokerageExclusionForEntity,
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";
import {
  joinSplitsForAnalytics,
  SPLIT_AMOUNT,
  SPLIT_CATEGORY_ID,
} from "../common/transaction-split-query.util";
import { applyTransactionSearch } from "./apply-transaction-search";
import { tagFilterExistsSql } from "./tag-key-filter.util";
import { RecurringCharge, detectFrequency } from "./recurring-charges.util";
import {
  loadQualifiedCategoryNames,
  qualifiedNamesById,
  resolveCategoryNamePaths,
  suggestQualifiedCategoryNames,
  UNCATEGORIZED_LABEL,
  UNKNOWN_CATEGORY_LABEL,
} from "../categories/category-name.util";
import {
  FIAT_MONEY_DECIMALS,
  roundMoney,
  sumMoney,
} from "../common/round.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { Account } from "../accounts/entities/account.entity";
import { FxAggregate } from "../common/fx-aggregate";
import { loadReportPlaces, reportPlacesOf } from "../common/report-figure";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import {
  buildRateIndex,
  RateIndex,
} from "../common/time-series/rate-index.util";
import { includesSpendingCategory } from "../built-in-reports/spending-reports.service";
import {
  convertDatedRowAggregates,
  convertDatedRows,
  convertRateBasis,
  toOwnRate,
} from "../built-in-reports/report-currency.service";
import {
  foldFxFeeTotals,
  FX_FEE_AMOUNT_SQL,
  FxFeeGranularity,
  FxFeeGranularityTotals,
  FxFeeMonthPart,
} from "./fx-fee-totals";
import {
  compareGroupKeys,
  convertRatePartAggregates,
  convertRateParts,
  foldRateParts,
  partRateBasis,
  RateBasisColumns,
  readTopGroupParts,
  splitByRateBasis,
} from "../built-in-reports/rate-basis-parts";
import {
  ownTransferLegs,
  transferRateSql,
} from "../built-in-reports/transfer-rate-sql";

/**
 * The ordinary-cash amount of one transaction, for the recurring-charge
 * detector: it reads one row per payment and joins no splits, so a split
 * parent's own amount (the sum of every line, embedded investment included) is
 * not what recurred.
 */
const RECURRING_REPORTABLE_AMOUNT = reportableTransactionAmountSql("t");

/** A percentage to two places is a whole number of basis points. */
const BASIS_POINTS_PER_UNIT = 10000;

/** `ratio` as a percentage rounded to two places (`0.12345` -> `12.35`). */
function percentToTwoPlaces(ratio: number): number {
  return Math.round(ratio * BASIS_POINTS_PER_UNIT) / 100;
}

/**
 * The Foreign Currency Fees report's figures over the accounts and paid
 * currencies the reader chose: each column, the grand total and each average
 * read once from the fees' aggregates (issue #2413).
 */
export interface FxFeeTotals {
  /** The accounts' shared currency, else the reader's reporting currency. */
  currency: string;
  /** Every fee read once; `null` while a fee was left out for want of a rate. */
  total: number | null;
  /** The fees that converted. */
  knownTotal: number;
  count: number;
  byGranularity: Record<FxFeeGranularity, FxFeeGranularityTotals>;
  /** Account currencies with no rate into `currency`; their fees are in no figure. */
  missingCurrencies: string[];
  /** Transactions whose fees were left out for want of a rate. */
  excludedCount: number;
}

export interface FxFeeMonthlySummaryRow {
  /** Calendar month in 'YYYY-MM'. */
  month: string;
  /** The currency the transaction was paid in (originalCurrencyCode). */
  currencyCode: string;
  /** Foreign-transaction fees for the month, positive, in account currency. */
  feeTotal: number;
  /** Number of foreign-entered transactions in the month. */
  count: number;
  /** The reader's reporting currency, which `convertedFeeTotal` is in. */
  convertedCurrency: string;
  /**
   * `feeTotal` with each transaction's fee at its own settled rate or the
   * market rate on its own date (issue #2106); null without an admissible one.
   */
  convertedFeeTotal: number | null;
}

/**
 * The values a register's payee and category pickers offer.
 *
 * Scoped to the accounts on screen, because a filter is a way through the rows
 * in front of you: a brokerage cash ledger has a handful of payees, and
 * offering the household's entire payee list to narrow it buries them.
 */
export interface RegisterFilterOptions {
  payees: { id: string; name: string }[];
  /**
   * Every category used by the rows, **plus the ancestors of each** -- a tree
   * picker nests a child under its parent and drops one whose parent is absent
   * (`MultiSelect` builds its top level from `parentId == null`), so a used
   * sub-category with an unused parent would simply not be offered.
   */
  categories: { id: string; name: string; parentId: string | null }[];
}

export interface TransferAccountSummary {
  accountId: string | null;
  accountName: string;
  currency: string;
  inbound: number;
  outbound: number;
  net: number;
  transferCount: number;
  /** The provisional legs inside `inbound` / `outbound`. */
  provisionalCount: number;
}

export interface TransfersByAccountResult {
  accounts: TransferAccountSummary[];
  /**
   * The accounts' amounts converted into `totalsCurrency`, each row at its own
   * rate or the rate on its own day (INV-FX-002), read at that currency's
   * places; `null` unless every one converted (`fxComplete`), the part that
   * did is in the `known*Subtotal` field. `accounts` stay in their own
   * currency.
   */
  totalInbound: number | null;
  totalOutbound: number | null;
  knownInboundSubtotal: number;
  knownOutboundSubtotal: number;
  totalsCurrency: string;
  fxComplete: boolean;
  /** `"CAD->USD"` for each pair with no rate; empty when `fxComplete`. */
  missingRatePairs: string[];
  transferCount: number;
  /** The provisional legs inside the two known subtotals (converted rows only). */
  provisionalCount: number;
}

/**
 * LLM06-F2: Minimum number of transactions required per group when
 * returning payee-level breakdowns. Groups below this threshold are
 * aggregated into an "Other (aggregated)" bucket to prevent revealing
 * individual transaction amounts through targeted queries.
 */
export const MIN_AGGREGATION_COUNT = 3;

export type LlmQueryDirection = "expenses" | "outgoing" | "income" | "both";
export type LlmQueryGroupBy = "category" | "payee" | "year" | "month" | "week";

/**
 * Group-by options for the unified `list_transactions` tool. Adds a "none"
 * sentinel on top of {@link LlmQueryGroupBy} so a caller can ask for totals
 * without any grouped breakdown.
 */
export type LlmListGroupBy = LlmQueryGroupBy | "none";

export interface LlmQueryTransactionsInput {
  startDate: string;
  endDate: string;
  accountIds?: string[];
  categoryIds?: string[];
  searchText?: string;
  groupBy?: LlmQueryGroupBy;
  direction?: LlmQueryDirection;
}

/**
 * The income, expense and net totals an AI or MCP caller reads, in ONE currency.
 *
 * Every row is converted into `totalsCurrency` at the rate for its own
 * transaction date (INV-FX-001, historical mode) before it is added. When any
 * row has no admissible rate the three totals are `null` -- a total with an
 * unconverted component is not a total -- and the partial sums travel in the
 * `known*Subtotal` fields beside the pairs to repair (`missingRatePairs`, as
 * `from->to`). `fxComplete` is the contract a caller reads with `=== false`.
 */
export interface LlmConvertedFlowFields {
  totalIncome: number | null;
  totalExpenses: number | null;
  netCashFlow: number | null;
  knownIncomeSubtotal: number;
  knownExpensesSubtotal: number;
  totalsCurrency: string;
  fxComplete: boolean;
  missingRatePairs: string[];
  /**
   * How many provisional transfer amounts (`amountIsProvisional`: Monize's
   * estimate until the other account's file is imported) the known totals
   * hold. They are included; nothing is withheld for them. 0 whenever the
   * read excludes transfers, as `list_transactions` and `query_transactions`
   * do; the MCP `financial-summary` and `recent-transactions` resources keep
   * transfers (`getLlmFlowTotals` with `excludeTransfers: false`), so theirs
   * can be above 0. A `transfers` rollup carries its own count.
   */
  provisionalCount: number;
}

export interface LlmQueryTransactionsResult extends LlmConvertedFlowFields {
  transactionCount: number;
  /** Per-currency and NOT converted: each entry is in its own currency. */
  byCurrency?: Record<
    string,
    {
      totalIncome: number;
      totalExpenses: number;
      netCashFlow: number;
      transactionCount: number;
    }
  >;
  breakdown?: unknown;
}

/**
 * Input for the unified `list_transactions` summary. Folds the filters of
 * `search_transactions` (search/amount/payee), the grouped breakdown of
 * `query_transactions`, and the per-account transfer rollup of `get_transfers`
 * into one shape. Callers resolve account/category/payee names to IDs first.
 */
export interface LlmListTransactionsInput {
  startDate: string;
  endDate: string;
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  searchText?: string;
  minAmount?: number;
  maxAmount?: number;
  direction?: LlmQueryDirection;
  groupBy?: LlmListGroupBy;
  transfersOnly?: boolean;
}

export interface LlmListTransactionsResult extends LlmConvertedFlowFields {
  transactionCount: number;
  /** Per-currency and NOT converted: each entry is in its own currency. */
  byCurrency?: Record<
    string,
    {
      totalIncome: number;
      totalExpenses: number;
      netCashFlow: number;
      transactionCount: number;
    }
  >;
  groupedBy: LlmListGroupBy;
  breakdown?: unknown;
  transfers?: TransfersByAccountResult;
}

export type LlmComparisonGroupBy = "category" | "payee";
export type LlmComparisonDirection = "expenses" | "income" | "both";

export interface LlmPeriodComparisonInput {
  period1Start: string;
  period1End: string;
  period2Start: string;
  period2End: string;
  groupBy?: LlmComparisonGroupBy;
  direction?: LlmComparisonDirection;
}

/**
 * One side of a period comparison, in `totalsCurrency`. `total` is `null` while
 * a row of the period has no rate; `knownSubtotal` is what did convert.
 */
export interface LlmComparisonPeriodTotal {
  start: string;
  end: string;
  total: number | null;
  knownSubtotal: number;
  /** The provisional amounts inside `knownSubtotal` (see {@link LlmConvertedFlowFields}). */
  provisionalCount: number;
}

export interface LlmPeriodComparisonResult {
  period1: LlmComparisonPeriodTotal;
  period2: LlmComparisonPeriodTotal;
  /** `null` unless both periods converted completely. */
  totalChange: number | null;
  /** `null` unless both periods converted completely. */
  totalChangePercent: number | null;
  totalsCurrency: string;
  fxComplete: boolean;
  missingRatePairs: string[];
  /** Each row's amounts are the rows that converted (see `fxComplete`). */
  comparison: Array<{
    label: string;
    period1Amount: number;
    period2Amount: number;
    change: number;
    changePercent: number | null;
  }>;
}

@Injectable()
export class TransactionAnalyticsService {
  private readonly logger = new Logger(TransactionAnalyticsService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Per-account transfer activity between the user's own accounts for a date
   * range: whole transfer rows plus a split's transfer lines, a line counted on
   * its parent's account at its own signed amount (INV-REPORT-006). Shared by the AI Assistant's tool executor and the MCP server so
   * both surfaces return the same shape. `inbound` counts positive-sign
   * transfer rows (money received), `outbound` counts the absolute value of
   * negative-sign rows (money sent). When no account filter is applied,
   * `totalInbound` equals `totalOutbound` (modulo multi-currency conversions)
   * because every transfer is stored as two linked rows, one on each side.
   */
  async getTransfersByAccount(
    userId: string,
    startDate: string,
    endDate: string,
    accountIds?: string[],
  ): Promise<TransfersByAccountResult> {
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "transferAccount")
        .select("transferAccount.name", "accountName")
        .addSelect("transferAccount.id", "accountId")
        .addSelect("t.currencyCode", "currencyCode")
        .addSelect(
          "SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)",
          "inbound",
        )
        .addSelect(
          "SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)",
          "outbound",
        )
        .addSelect("COUNT(*)", "count")
        // Every row here is a whole transfer leg, the only kind that can be
        // provisional (design section 6, P5).
        .addSelect(
          "COUNT(*) FILTER (WHERE t.amountIsProvisional = true)",
          "provisionalCount",
        )
        .where("t.userId = :userId", { userId })
        .andWhere("t.isTransfer = true")
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .groupBy("transferAccount.id")
        .addGroupBy("transferAccount.name")
        .addGroupBy("t.currencyCode")
        .orderBy("transferAccount.name", "ASC");

      if (accountIds && accountIds.length > 0) {
        qb.andWhere("t.accountId IN (:...accountIds)", { accountIds });
      }

      // A foreign part is split by its day and the rate it settled at, so the
      // totals convert per row as the headline totals do (INV-FX-002).
      splitByRateBasis(
        qb,
        {
          currency: "t.currencyCode",
          date: "t.transactionDate",
          originalCurrency: "t.originalCurrencyCode",
          exchangeRate: "t.exchangeRate",
          transferLegs: { transactionAlias: "t" },
        },
        reporting,
      );
      const wholeRows = await qb.getRawMany();

      // A split's transfer line is a transfer of its parent's account, at the
      // line's own signed amount and the parent's currency (INV-REPORT-006).
      // Same scope as the whole-row query above, so inbound and outbound net.
      const lineParams: unknown[] = [userId, startDate, endDate];
      let lineScope = "";
      if (accountIds && accountIds.length > 0) {
        lineScope = ` AND t.account_id = ANY($4::uuid[])`;
        lineParams.push(accountIds);
      }
      const reportingParam = `$${lineParams.push(reporting)}::text`;
      const foreignSql = `t.currency_code <> ${reportingParam}`;
      const legs = ownTransferLegs(userId, "$1", "ts");
      const lineRows: typeof wholeRows = await m.query(
        `SELECT a.name AS "accountName", a.id AS "accountId",
                t.currency_code AS "currencyCode",
                SUM(CASE WHEN ts.amount > 0 THEN ts.amount ELSE 0 END) AS inbound,
                SUM(CASE WHEN ts.amount < 0 THEN ABS(ts.amount) ELSE 0 END) AS outbound,
                COUNT(*) AS count,
                CASE WHEN ${foreignSql} THEN TO_CHAR(t.transaction_date, 'YYYY-MM-DD') END AS fx_day,
                CASE WHEN ${foreignSql} THEN t.original_currency_code END AS fx_original_currency,
                CASE WHEN ${foreignSql} THEN t.exchange_rate END AS fx_exchange_rate${
                  legs
                    ? `,
                ${transferRateSql(reportingParam, "t", legs)} AS fx_transfer_rate`
                    : ""
                }
           FROM transactions t
           JOIN transaction_splits ts ON ts.transaction_id = t.id
           JOIN accounts a ON a.id = t.account_id
          WHERE t.user_id = $1
            AND ts.transfer_account_id IS NOT NULL
            AND t.transaction_date >= $2
            AND t.transaction_date <= $3
            AND (t.status IS NULL OR t.status != 'VOID')
            ${lineScope}
          GROUP BY a.id, a.name, t.currency_code, fx_day, fx_original_currency,
                   fx_exchange_rate${legs ? ", fx_transfer_rate" : ""}`,
        lineParams,
      );

      const currencies = [...wholeRows, ...lineRows].map((r) => r.currencyCode);
      // Each row is in its account's currency, rounded at its precision.
      const places = await loadCurrencyPlacesForRead(m, currencies);
      const merged = new Map<string, Record<string, unknown>>();
      for (const r of [...wholeRows, ...lineRows]) {
        const key = `${r.accountId}|${r.currencyCode}`;
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, { ...r });
          continue;
        }
        const decimals = moneyDecimalsForCode(places, r.currencyCode);
        for (const f of [
          "inbound",
          "outbound",
          "count",
          "provisionalCount",
        ] as const) {
          prev[f] = sumMoney(
            [Number(prev[f]) || 0, Number(r[f]) || 0],
            f === "inbound" || f === "outbound" ? decimals : 0,
          );
        }
      }
      const rows = [...merged.values()].sort((x, y) =>
        String(x.accountName).localeCompare(String(y.accountName)),
      ) as typeof wholeRows;
      const accounts: TransferAccountSummary[] = rows.map((r) => {
        const decimals = moneyDecimalsForCode(places, r.currencyCode);
        const inbound = roundMoney(Number(r.inbound) || 0, decimals);
        const outbound = roundMoney(Number(r.outbound) || 0, decimals);
        return {
          accountId: r.accountId ?? null,
          accountName: r.accountName,
          currency: r.currencyCode,
          inbound,
          outbound,
          net: roundMoney(inbound - outbound, decimals),
          transferCount: Number(r.count) || 0,
          provisionalCount: Number(r.provisionalCount) || 0,
        };
      });

      // Each part (an account's rows of one day and rate) converts at the rate
      // it settled at, else the market rate on its own day, as the headline
      // totals do; a part with no rate is named and left out of the known
      // subtotal, with its provisional legs.
      const parts = [...wholeRows, ...lineRows].map((r) => ({
        ...r,
        txDate: r.fx_day ?? null,
      }));
      const rates = await this.loadRateIndex(
        m,
        parts,
        reporting,
        startDate,
        endDate,
      );
      const reportPlaces = await loadReportPlaces(m, reporting);
      const inbound = new FxAggregate();
      const outbound = new FxAggregate();
      let convertedProvisional = 0;
      for (const part of parts) {
        const inboundIn = addDatedAmount(
          inbound,
          Number(part.inbound) || 0,
          part,
          reporting,
          rates,
          this.logger,
        );
        const outboundIn = addDatedAmount(
          outbound,
          Number(part.outbound) || 0,
          part,
          reporting,
          rates,
          this.logger,
        );
        if (inboundIn && outboundIn) {
          convertedProvisional += Number(part.provisionalCount) || 0;
        }
      }
      const fxComplete = inbound.isComplete && outbound.isComplete;
      return {
        accounts,
        totalInbound: inbound.totalAt(reportPlaces),
        totalOutbound: outbound.totalAt(reportPlaces),
        knownInboundSubtotal: inbound.knownSubtotalAt(reportPlaces),
        knownOutboundSubtotal: outbound.knownSubtotalAt(reportPlaces),
        totalsCurrency: reporting,
        fxComplete,
        missingRatePairs: FxAggregate.sum([inbound, outbound]).missingPairs,
        transferCount: accounts.reduce((s, a) => s + a.transferCount, 0),
        provisionalCount: convertedProvisional,
      };
    });
  }

  /**
   * The payees and categories actually used by the rows in the given accounts.
   *
   * A split's category lives on the split row, not on its parent (whose
   * `categoryId` is NULL), so both are read -- the register's own category
   * filter matches split lines, and a picker that could not offer those
   * categories would be narrower than the filter it feeds.
   */
  async getRegisterFilterOptions(
    userId: string,
    filters: { accountIds?: string[]; jointAccountIds?: string[] } = {},
  ): Promise<RegisterFilterOptions> {
    const { accountIds, jointAccountIds = [] } = filters;
    return withScopedDb(this.dataSource, async (m) => {
      const scoped = <T extends object>(
        qb: import("typeorm").SelectQueryBuilder<T>,
      ) => {
        qb.where(this.analyticsScope(userId, jointAccountIds));
        if (accountIds && accountIds.length > 0) {
          qb.andWhere("transaction.accountId IN (:...filterAccountIds)", {
            filterAccountIds: accountIds,
          });
        }
        return qb;
      };

      const payeeRows = await scoped(
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .innerJoin("transaction.payee", "payee")
          .select("payee.id", "id")
          .addSelect("payee.name", "name")
          .distinct(true),
      )
        .orderBy("payee.name", "ASC")
        .getRawMany<{ id: string; name: string }>();

      const ownCategoryRows = await scoped(
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .select("transaction.categoryId", "id")
          .distinct(true),
      )
        .andWhere("transaction.categoryId IS NOT NULL")
        .getRawMany<{ id: string }>();

      const splitCategoryRows = await scoped(
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .innerJoin("transaction.splits", "split")
          .select("split.categoryId", "id")
          .distinct(true),
      )
        .andWhere("split.categoryId IS NOT NULL")
        .getRawMany<{ id: string }>();

      const usedCategoryIds = new Set(
        [...ownCategoryRows, ...splitCategoryRows].map((r) => r.id),
      );
      if (usedCategoryIds.size === 0) {
        return { payees: payeeRows, categories: [] };
      }

      // The whole tree, so an ancestor can be resolved without a query per
      // level. A user's chart of accounts is tens to hundreds of rows.
      const allCategories = await m.getRepository(Category).find({
        where: { userId },
        select: { id: true, name: true, parentId: true },
      });
      const byId = new Map(allCategories.map((c) => [c.id, c]));

      const includedIds = new Set<string>();
      for (const usedId of usedCategoryIds) {
        // Walk up from each used category. `seen` stops a cycle -- a parent
        // chain is data, and a self-referential row would otherwise hang here.
        const seen = new Set<string>();
        let current = byId.get(usedId);
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          includedIds.add(current.id);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
      }

      const categories = allCategories
        .filter((c) => includedIds.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { payees: payeeRows, categories };
    });
  }

  async getSummary(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    excludeInvestmentLinked?: boolean,
    excludeTransfers?: boolean,
    tagIds?: string[],
    jointAccountIds?: string[],
    /**
     * Add `converted`, the buckets in the reporting currency at each row's own
     * rate or date. Opt-in: it splits each foreign bucket of the one read by
     * day and own rate, and only the summary endpoint's readers (the category
     * and payee pages and widgets) use it.
     */
    options: { inReportingCurrency?: boolean } = {},
  ): Promise<{
    /** `null` when the period holds more than one currency: read `converted`. */
    totalIncome: number | null;
    totalExpenses: number | null;
    netCashFlow: number | null;
    transactionCount: number;
    /** The provisional transfer amounts inside the totals above. */
    provisionalCount: number;
    firstTransactionDate: string | null;
    lastTransactionDate: string | null;
    byCurrency: Record<
      string,
      {
        totalIncome: number;
        totalExpenses: number;
        netCashFlow: number;
        transactionCount: number;
      }
    >;
    converted?: SummaryInReportingCurrency;
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      const filters: AnalyticsReadFilters = {
        accountIds,
        startDate,
        endDate,
        categoryIds,
        payeeIds,
        search,
        amountFrom,
        amountTo,
        excludeInvestmentLinked,
        excludeTransfers,
        tagIds,
        jointAccountIds,
      };
      const reporting = options.inReportingCurrency
        ? await resolveUserDefaultCurrency(this.dataSource, userId)
        : undefined;
      const queryBuilder = await this.createFilteredAnalyticsQuery(
        m,
        userId,
        filters,
      );

      // Use the split amount when the row came from the splits join;
      // otherwise the transaction's own amount. A split parent's `amount`
      // equals the sum of its splits, so only one of the two contributes
      // per row.
      const amountExpr = "COALESCE(splits.amount, transaction.amount)";

      queryBuilder
        .select("transaction.currencyCode", "currencyCode")
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} > 0 THEN ${amountExpr} ELSE 0 END)`,
          "totalIncome",
        )
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} < 0 THEN ABS(${amountExpr}) ELSE 0 END)`,
          "totalExpenses",
        )
        .addSelect(WHOLE_ROW_COUNT_SQL, "transactionCount")
        .addSelect(SPLIT_IDS_SQL, "splitIds")
        .addSelect(PROVISIONAL_COUNT_SQL, "provisionalCount")
        .addSelect(
          "TO_CHAR(MIN(transaction.transactionDate), 'YYYY-MM-DD')",
          "firstDate",
        )
        .addSelect(
          "TO_CHAR(MAX(transaction.transactionDate), 'YYYY-MM-DD')",
          "lastDate",
        )
        .groupBy("transaction.currencyCode");
      // Converting splits each foreign bucket by day and own rate in this same
      // read, so the conversion needs no second pass over the filtered rows.
      if (reporting)
        splitByRateBasis(
          queryBuilder,
          excludeTransfers
            ? TRANSACTION_OWN_RATE_BASIS
            : TRANSACTION_RATE_BASIS,
          reporting,
        );

      const rows: RawGroupRow[] = await queryBuilder.getRawMany();

      let totalIncome = 0;
      let totalExpenses = 0;
      let transactionCount = 0;
      let firstTransactionDate: string | null = null;
      let lastTransactionDate: string | null = null;
      const byCurrency: Record<
        string,
        {
          totalIncome: number;
          totalExpenses: number;
          netCashFlow: number;
          transactionCount: number;
        }
      > = {};
      // A net is a difference of two amounts at the currency's places, rounded
      // there, never a bare float delta.
      const places = await loadCurrencyPlacesForRead(
        m,
        rows.map((row) => row.currencyCode).filter(Boolean),
      );

      for (const bucket of foldRateParts(
        rows,
        (row) => row.currencyCode ?? "",
        {
          sums: ["totalIncome", "totalExpenses"],
          count: "transactionCount",
          splitIds: "splitIds",
        },
      )) {
        const income = bucket.sums.totalIncome;
        const expenses = bucket.sums.totalExpenses;
        totalIncome += income;
        totalExpenses += expenses;
        transactionCount += bucket.count;
        if (bucket.first.currencyCode) {
          byCurrency[bucket.first.currencyCode] = {
            totalIncome: income,
            totalExpenses: expenses,
            netCashFlow: roundMoney(
              income - expenses,
              moneyDecimalsForCode(places, bucket.first.currencyCode),
            ),
            transactionCount: bucket.count,
          };
        }
      }
      for (const row of rows) {
        // ISO date strings compare correctly as strings, so the min/max
        // across per-currency rows reduces with a plain comparison.
        if (
          row.firstDate &&
          (!firstTransactionDate || row.firstDate < firstTransactionDate)
        ) {
          firstTransactionDate = row.firstDate;
        }
        if (
          row.lastDate &&
          (!lastTransactionDate || row.lastDate > lastTransactionDate)
        ) {
          lastTransactionDate = row.lastDate;
        }
      }

      const provisional = provisionalCountsBy(
        rows,
        (row) => row.currencyCode ?? "",
      );
      const converted = reporting
        ? await this.summaryInReportingCurrency(
            m,
            rows,
            byCurrency,
            reporting,
            provisional,
          )
        : undefined;

      // Native sums mean something only inside one currency; across several the
      // answer is the `converted` block, never a raw sum of unlike units.
      const codes = Object.keys(byCurrency);
      const oneCurrency = codes.length <= 1;
      const decimals = moneyDecimalsForCode(places, codes[0] ?? "");
      return {
        totalIncome: oneCurrency ? roundMoney(totalIncome, decimals) : null,
        totalExpenses: oneCurrency ? roundMoney(totalExpenses, decimals) : null,
        netCashFlow: oneCurrency
          ? roundMoney(totalIncome - totalExpenses, decimals)
          : null,
        transactionCount,
        provisionalCount: [...provisional.values()].reduce(
          (sum, count) => sum + count,
          0,
        ),
        firstTransactionDate,
        lastTransactionDate,
        byCurrency,
        ...(converted ? { converted } : {}),
      };
    });
  }

  /**
   * A summary's buckets in the reader's reporting currency, each foreign row at
   * its own rate or the market rate on its own date, never at today's (issue
   * #2106). A bucket with no admissible rate is left out of both figures and
   * named, so a surface labels the figures partial rather than short.
   * `provisional` is each currency's provisional legs; only an included
   * bucket's are counted (design section 8).
   */
  private async summaryInReportingCurrency(
    m: EntityManager,
    parts: readonly RawGroupRow[],
    byCurrency: Record<
      string,
      { totalIncome: number; totalExpenses: number; transactionCount: number }
    >,
    reporting: string,
    provisional: ReadonlyMap<string, number>,
  ): Promise<SummaryInReportingCurrency> {
    const foreign = await convertRatePartAggregates(
      (sql, params) => m.query(sql, params),
      parts,
      reporting,
      (row) => row.currencyCode,
      { sums: ["totalIncome", "totalExpenses"], currency: "currencyCode" },
      this.logger,
    );

    // Each currency's converted figures fold as aggregates, so the totals and
    // the net are each rounded once: adding the currencies' four-place
    // readings read two 124.752474 halves as 249.5050
    // (docs/specs/report-rounding-and-aggregation.md rule 2).
    const income = new FxAggregate();
    const expenses = new FxAggregate();
    let includedTransactionCount = 0;
    let excludedTransactionCount = 0;
    let provisionalCount = 0;
    const missing: string[] = [];
    for (const [code, bucket] of Object.entries(byCurrency)) {
      if (code === reporting) {
        income.addConverted(bucket.totalIncome);
        expenses.addConverted(bucket.totalExpenses);
        includedTransactionCount += bucket.transactionCount;
        provisionalCount += provisional.get(code) ?? 0;
        continue;
      }
      const converted = foreign.get(code);
      if (
        converted &&
        (converted.totalIncome === null || converted.totalExpenses === null)
      ) {
        missing.push(code);
        excludedTransactionCount += bucket.transactionCount;
        continue;
      }
      if (converted?.totalIncome) income.merge(converted.totalIncome);
      if (converted?.totalExpenses) expenses.merge(converted.totalExpenses);
      includedTransactionCount += bucket.transactionCount;
      provisionalCount += provisional.get(code) ?? 0;
    }
    const net = FxAggregate.difference(income, expenses);
    const complete = missing.length === 0;
    return {
      currency: reporting,
      totalIncome: complete ? income.knownSubtotal : null,
      totalExpenses: complete ? expenses.knownSubtotal : null,
      netCashFlow: complete ? net.knownSubtotal : null,
      knownIncome: income.knownSubtotal,
      knownExpenses: expenses.knownSubtotal,
      knownNet: net.knownSubtotal,
      includedTransactionCount,
      excludedTransactionCount,
      provisionalCount,
      missingCurrencies: missing.sort(),
    };
  }

  /**
   * The analytics read scope, mirroring the register's (joint-accounts spec):
   * the user's own rows plus rows in accounts jointly shared to them.
   * `jointAccountIds` is the already-authorized joint set computed by the
   * controller, never raw request input. An empty joint set reproduces the old
   * owner-only predicate exactly, so non-joint traffic is untouched.
   */
  private analyticsScope(userId: string, jointAccountIds: string[]): Brackets {
    return new Brackets((qb) => {
      qb.where("transaction.userId = :analyticsScopeUserId", {
        analyticsScopeUserId: userId,
      });
      if (jointAccountIds.length > 0) {
        qb.orWhere("transaction.accountId IN (:...analyticsScopeJointIds)", {
          analyticsScopeJointIds: jointAccountIds,
        });
      }
    });
  }

  /**
   * Base query shared by {@link getSummary} and {@link getGroupedTotals}:
   * applies the full transaction-list filter surface (accounts incl. the
   * brokerage exclusion, dates, categories with descendant expansion and
   * the `uncategorized`/`transfer` pseudo-ids, payees, search, amount
   * range, tags) with splits always joined so split transactions count
   * per matching split via `COALESCE(splits.amount, transaction.amount)`.
   *
   * `jointAccountIds` widens the ownership predicate only; category
   * descendant expansion still resolves against `userId`'s own tree, so a
   * caller that both filters by category and widens by joint ids must pass
   * the owning user (which is what the single-joint-account path does).
   */
  private async createFilteredAnalyticsQuery(
    m: EntityManager,
    userId: string,
    filters: AnalyticsReadFilters,
  ) {
    const {
      accountIds,
      startDate,
      endDate,
      categoryIds,
      payeeIds,
      search,
      amountFrom,
      amountTo,
      excludeInvestmentLinked,
      excludeTransfers,
      tagIds,
      includeUnreconciledBeforeStart,
      jointAccountIds,
    } = filters;

    const queryBuilder = m
      .getRepository(Transaction)
      .createQueryBuilder("transaction")
      .where(this.analyticsScope(userId, jointAccountIds ?? []));

    // Join account for filtering and uncategorized conditions.
    // Use the same exclusion logic as findAll() so the summary
    // counts/totals match the transaction list.
    queryBuilder.leftJoin("transaction.account", "summaryAccount");

    queryBuilder.andWhere(brokerageExclusionForEntity("summaryAccount"));

    // A voided row moved no balance, so no amount aggregate counts it (the
    // list endpoint still shows it). A NULL status predates the column.
    queryBuilder.andWhere(
      "(transaction.status IS NULL OR transaction.status != 'VOID')",
    );

    // Always expand split transactions so mixed-sign splits are bucketed
    // into income/expense per split. A split parent carries `amount =
    // SUM(splits)`, so summing the parent row nets opposite-sign splits
    // together and under-counts both totalIncome and totalExpenses.
    // A split's transfer line goes with the whole transfer rows: out with
    // `excludeTransfers`, in otherwise. It is the outgoing side of a transfer
    // whose incoming row is a whole row, so a read keeping one without the
    // other counts half the transfer (issue #2337).
    queryBuilder.leftJoin("transaction.splits", "splits");
    if (excludeTransfers) {
      queryBuilder.andWhere(
        "(splits.transferAccountId IS NULL OR splits.id IS NULL)",
      );
    }
    // ...and an embedded investment line is the trade's own cash side, not
    // ordinary cash. Unconditional, unlike excludeInvestmentLinked below: that
    // flag is about whole rows a caller may want to see, while this line's
    // amount would otherwise land in the NULL "Uncategorized" bucket of every
    // grouped total -- whose drill-down (the register filtered to
    // uncategorized) excludes it, so the two disagreed by the trade amount.
    queryBuilder.andWhere(investmentLinkedSplitExclusion("splits"));

    // Optionally exclude cash-side transactions created as a side-effect
    // of an investment BUY/SELL/DIVIDEND. Those transactions live in the
    // linked cash account (so the account-subtype filter above can't see
    // them), carry no category, and have no transfer flag -- so they
    // leak into expense/income totals as "uncategorised" spending.
    if (excludeInvestmentLinked) {
      queryBuilder.andWhere(
        investmentLinkedTransactionExclusion("transaction"),
      );
    }

    // Optionally exclude transfers between own accounts. These net to
    // zero across both sides but inflate per-side income/expense totals,
    // so AI and analytics callers asking "how much did I spend" want
    // them out. Callers that include "transfer" as a pseudo-category
    // below must not set this flag, or the OR clause will match nothing.
    if (excludeTransfers) {
      queryBuilder.andWhere("transaction.isTransfer = false");
    }

    if (accountIds && accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds,
      });
    }

    if (startDate) {
      if (includeUnreconciledBeforeStart) {
        // Credit-card "spending this cycle" widget: also count charges dated
        // before the cycle start that have not yet been reconciled onto a
        // statement. They usually posted late but still belong to what is
        // owed. Reconciled and voided prior transactions stay excluded; a NULL
        // status predates the status column and counts as unreconciled.
        queryBuilder.andWhere(
          new Brackets((qb) => {
            qb.where("transaction.transactionDate >= :startDate", {
              startDate,
            }).orWhere(
              "(transaction.status IS NULL OR transaction.status NOT IN ('RECONCILED', 'VOID'))",
            );
          }),
        );
      } else {
        queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
          startDate,
        });
      }
    }

    if (endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate,
      });
    }

    if (categoryIds && categoryIds.length > 0) {
      const hasUncategorized = categoryIds.includes("uncategorized");
      const hasTransfer = categoryIds.includes("transfer");
      const regularCategoryIds = categoryIds.filter(
        (id) => id !== "uncategorized" && id !== "transfer",
      );

      let hasCondition = false;

      if (hasUncategorized || hasTransfer || regularCategoryIds.length > 0) {
        const uniqueCategoryIds =
          regularCategoryIds.length > 0
            ? await getAllCategoryIdsWithChildren(
                m.getRepository(Category),
                userId,
                regularCategoryIds,
              )
            : [];

        queryBuilder.andWhere(
          new Brackets((qb) => {
            if (hasUncategorized) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method](
                new Brackets((unc) => {
                  unc
                    .where(
                      `transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND ${investmentLinkedTransactionExclusion(
                        "transaction",
                      )}`,
                    )
                    // A split transaction counts as uncategorised when any of
                    // its non-transfer split lines has no category (a read
                    // with transfers keeps transfer lines; not here),
                    // matching the category breakdown grouping.
                    .orWhere(
                      `transaction.isSplit = true AND transaction.isTransfer = false AND splits.categoryId IS NULL AND splits.transferAccountId IS NULL AND ${investmentLinkedSplitExclusion(
                        "splits",
                      )}`,
                    );
                }),
              );
            }
            if (hasTransfer) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method](
                "(transaction.isTransfer = true OR splits.transferAccountId IS NOT NULL)",
              );
            }
            if (uniqueCategoryIds.length > 0) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method](
                new Brackets((inner) => {
                  inner
                    .where(
                      "transaction.categoryId IN (:...summaryCategoryIds)",
                      { summaryCategoryIds: uniqueCategoryIds },
                    )
                    .orWhere("splits.categoryId IN (:...summaryCategoryIds)", {
                      summaryCategoryIds: uniqueCategoryIds,
                    });
                }),
              );
            }
          }),
        );
      }
    }

    if (payeeIds && payeeIds.length > 0) {
      queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
        payeeIds,
      });
    }

    // Split grain on the joined `splits` alias: the totals count the
    // matching lines, as the register draws them.
    await applyTransactionSearch(m, queryBuilder, search, {
      userId,
      transaction: "transaction",
      splits: "splits",
      grain: "split",
      paramPrefix: "srch",
    });

    if (amountFrom !== undefined) {
      queryBuilder.andWhere("transaction.amount >= :amountFrom", {
        amountFrom,
      });
    }

    if (amountTo !== undefined) {
      queryBuilder.andWhere("transaction.amount <= :amountTo", { amountTo });
    }

    if (tagIds && tagIds.length > 0) {
      // EXISTS, not joins: a join per tag multiplies a line, and SUM then
      // counts it once per matching tag.
      queryBuilder.andWhere(
        tagFilterExistsSql("transaction", "splits", "summaryTagIds"),
        { summaryTagIds: tagIds },
      );
    }

    return queryBuilder;
  }

  /**
   * Totals grouped by category or payee under the same filter semantics
   * as {@link getSummary}, so a widget's breakdown reconciles with its
   * headline summary and with the transaction list. Rows are keyed by
   * entity id (null = uncategorized / no payee) and split per currency;
   * `total` keeps its sign so income and refunds remain visible.
   *
   * Unlike the private LLM breakdown, this returns ids (rows must be
   * clickable in the UI) and applies no minimum-count aggregation.
   */
  async getGroupedTotals(
    userId: string,
    params: {
      groupBy: "category" | "payee";
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      limit?: number;
      includeUnreconciledBeforeStart?: boolean;
      jointAccountIds?: string[];
    },
  ): Promise<Array<GroupedTotalRow>> {
    return withScopedDb(this.dataSource, async (m) => {
      const { groupBy, limit, ...filters } = params;

      const queryBuilder = await this.createFilteredAnalyticsQuery(
        m,
        userId,
        filters,
      );

      const amountExpr = "COALESCE(splits.amount, transaction.amount)";
      // A split row's own category wins over the parent transaction's.
      const categoryIdExpr =
        "COALESCE(splits.categoryId, transaction.categoryId)";
      // Transfers are movements between own accounts, not spending, so a
      // transfer with no category, a whole row or a split's transfer line,
      // must not swell the "Uncategorized" bucket. This matches the
      // transaction-list filter, which excludes transfers from
      // "uncategorized". A transfer carrying an optional category still shows
      // under that category.
      const categorizedOrNotTransfer = () =>
        new Brackets((qb) => {
          qb.where(`${categoryIdExpr} IS NOT NULL`).orWhere(
            "transaction.isTransfer = false AND splits.transferAccountId IS NULL",
          );
        });

      const idExpr =
        groupBy === "category" ? categoryIdExpr : "transaction.payeeId";
      const nameExpr =
        groupBy === "category"
          ? "COALESCE(groupSplitCat.name, groupCat.name)"
          : "COALESCE(groupPayee.name, transaction.payeeName)";
      // A group's category type, so a surface labels a Transfer category's
      // group a transfer rather than spending or income
      // (docs/specs/transfer-categories.md section 9). One per id, so it adds
      // no group.
      const typeExpr =
        groupBy === "category"
          ? "COALESCE(groupSplitCat.categoryType, groupCat.categoryType)"
          : "NULL";
      if (groupBy === "category") {
        queryBuilder
          .leftJoin("transaction.category", "groupCat")
          .leftJoin("splits.category", "groupSplitCat")
          .andWhere(categorizedOrNotTransfer());
      } else {
        queryBuilder.leftJoin("transaction.payee", "groupPayee");
      }
      queryBuilder
        .select(idExpr, "id")
        .addSelect(nameExpr, "name")
        .addSelect(typeExpr, "categoryType")
        .groupBy(idExpr)
        .addGroupBy(nameExpr);
      if (groupBy === "category") queryBuilder.addGroupBy(typeExpr);

      queryBuilder
        .addSelect("transaction.currencyCode", "currencyCode")
        .addSelect(`SUM(${amountExpr})`, "total")
        .addSelect(`SUM(ABS(${amountExpr}))`, "magnitude")
        .addSelect(WHOLE_ROW_COUNT_SQL, "count")
        .addSelect(SPLIT_IDS_SQL, "splitIds")
        .addSelect(PROVISIONAL_COUNT_SQL, "provisionalCount")
        .addGroupBy("transaction.currencyCode");
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      splitByRateBasis(queryBuilder, TRANSACTION_RATE_BASIS, reporting);
      // A row is keyed by id AND name, as the read groups it: free-text payees
      // share a null id, and keying on the id alone gave every one of them the
      // converted total of them all.
      const parts = await readTopGroupParts(
        m,
        queryBuilder,
        `CONCAT(COALESCE(CAST(${idExpr} AS text), ''), '#', COALESCE(${nameExpr}, ''), '|', transaction.currencyCode)`,
        "magnitude",
        clampGroupLimit(limit),
      );

      return this.groupsWithConvertedTotals(
        m,
        parts,
        reporting,
        "magnitude",
        (row) => ({
          id: (row.id ?? null) as string | null,
          name: (row.name ?? null) as string | null,
          categoryType: isCategoryType(row.categoryType)
            ? row.categoryType
            : null,
        }),
      );
    });
  }

  /**
   * Fold the parts {@link readTopGroupParts} kept into one row per group, in
   * its order (largest first by `magnitude`, then by key), each with its figure
   * in the reader's reporting currency
   * beside it at each underlying row's own rate or the market rate on its own
   * date (issue #2106): a surface that sums several currencies reads
   * `convertedTotal` rather than converting a lifetime total at today's rate.
   * `null` is a row with a part no admissible rate reaches. `provisionalCount`
   * is the provisional legs inside the row's own `total`.
   */
  private async groupsWithConvertedTotals<L extends object>(
    m: EntityManager,
    parts: readonly RawGroupRow[],
    reporting: string,
    magnitude: string,
    labelOf: (row: RawGroupRow) => L,
  ): Promise<
    Array<
      L & {
        currencyCode: string;
        total: number;
        count: number;
        provisionalCount: number;
        convertedCurrency: string;
        convertedTotal: number | null;
      }
    >
  > {
    const keyOf = (row: RawGroupRow) => String(row.group_key);
    const provisional = provisionalCountsBy(parts, keyOf);
    const sums = magnitude === "total" ? ["total"] : ["total", magnitude];
    const groups = foldRateParts(parts, keyOf, {
      sums,
      count: "count",
      splitIds: "splitIds",
    }).sort(
      (a, b) =>
        b.sums[magnitude] - a.sums[magnitude] || compareGroupKeys(a.key, b.key),
    );
    if (groups.length === 0) return [];
    const foreign = await convertRateParts(
      (sql, params) => m.query(sql, params),
      parts,
      reporting,
      keyOf,
      { sums: ["total"], currency: "currencyCode" },
      // A widget's breakdown beside its own four-place summary, not a report
      // figure.
      FIAT_MONEY_DECIMALS,
      this.logger,
    );
    // Per-currency rows, each rounded at its currency's precision.
    const places = await loadCurrencyPlacesForRead(
      m,
      groups.map((g) => g.first.currencyCode),
    );
    return groups.map((g) => {
      const currencyCode = g.first.currencyCode as string;
      const total = roundMoney(
        g.sums.total,
        moneyDecimalsForCode(places, currencyCode),
      );
      return {
        ...labelOf(g.first),
        currencyCode,
        total,
        count: g.count,
        provisionalCount: provisional.get(g.key) ?? 0,
        convertedCurrency: reporting,
        convertedTotal:
          currencyCode === reporting
            ? total
            : (foreign.get(g.key)?.total ?? null),
      };
    });
  }

  /**
   * Spending broken down by the VALUE of a single KEY:VALUE tag key, over the
   * standard transaction-list filter surface. Each transaction's absolute
   * amount is attributed to the value(s) of its own `<key>:*` tags (a
   * transaction tagged both `country:usa` and `country:poland` counts under
   * each, so shares can sum past 100%). Split amounts are summed via
   * `COALESCE(splits.amount, transaction.amount)`, so split transactions still
   * total correctly; brokerage side-transactions are excluded by the shared
   * base query, and a transfer counts on each tagged side, a split's transfer
   * line under its parent's tags. Attribution is transaction-level -- split-level tags
   * are not considered here. Rows are per-currency (like `getGroupedTotals`) so
   * the caller converts to a single display currency.
   */
  async getTransactionBreakdownByTagKey(
    userId: string,
    key: string,
    params: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      limit?: number;
    } = {},
  ): Promise<
    Array<{
      id: string;
      name: string;
      currencyCode: string;
      total: number;
      count: number;
      provisionalCount: number;
      convertedCurrency: string;
      convertedTotal: number | null;
    }>
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const { limit, ...filters } = params;
      const queryBuilder = await this.createFilteredAnalyticsQuery(
        m,
        userId,
        filters,
      );

      const amountExpr = "COALESCE(splits.amount, transaction.amount)";
      const valueExpr =
        "TRIM(SUBSTRING(brkTag.name FROM POSITION(':' IN brkTag.name) + 1))";
      queryBuilder
        .innerJoin("transaction.tags", "brkTag")
        .andWhere("POSITION(':' IN brkTag.name) > 1")
        .andWhere(
          "LOWER(TRIM(SPLIT_PART(brkTag.name, ':', 1))) = LOWER(:brkKey)",
          {
            brkKey: key.trim(),
          },
        )
        .andWhere(`${valueExpr} <> ''`)
        .select(valueExpr, "value")
        .addSelect("transaction.currencyCode", "currencyCode")
        .addSelect(`SUM(ABS(${amountExpr}))`, "total")
        .addSelect(WHOLE_ROW_COUNT_SQL, "count")
        .addSelect(SPLIT_IDS_SQL, "splitIds")
        .addSelect(PROVISIONAL_COUNT_SQL, "provisionalCount")
        .groupBy(valueExpr)
        .addGroupBy("transaction.currencyCode");
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      splitByRateBasis(queryBuilder, TRANSACTION_RATE_BASIS, reporting);
      // The total is a magnitude already, so the groups rank by it.
      const parts = await readTopGroupParts(
        m,
        queryBuilder,
        `CONCAT(${valueExpr}, '|', transaction.currencyCode)`,
        "total",
        clampGroupLimit(limit),
      );

      return this.groupsWithConvertedTotals(
        m,
        parts,
        reporting,
        "total",
        (row) => ({ id: row.value as string, name: row.value as string }),
      );
    });
  }

  async getMonthlyTotals(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
    jointAccountIds?: string[],
  ): Promise<
    Array<{
      month: string;
      currency: string;
      total: number | null;
      knownSubtotal?: number;
      count: number;
      /** The provisional amounts inside `total` / `knownSubtotal`. */
      provisionalCount: number;
    }>
  > {
    return withScopedDb(this.dataSource, async (m) => {
      // Reuse the same filtered query builder as getSummary so the chart's
      // per-month totals and counts reconcile exactly with the category/payee
      // info widget's headline summary -- identical brokerage exclusion, split
      // expansion, and transfer-split handling. Previously this method duplicated
      // the filter logic with slightly different semantics (no transfer-split
      // exclusion, conditional split join), which let the chart footer count and
      // the widget count diverge and read as a stale/"caching" mismatch.
      // getMonthlyTotals is only called when filters are active (the frontend
      // switches to daily balances otherwise). Like the summary, it counts
      // both sides of every transfer, a split's transfer line included
      // (issue #2337).
      const queryBuilder = await this.createFilteredAnalyticsQuery(m, userId, {
        accountIds,
        startDate,
        endDate,
        categoryIds,
        payeeIds,
        search,
        amountFrom,
        amountTo,
        tagIds,
        jointAccountIds,
      });

      // The splits join is always present, so use the split amount for split
      // transactions (COALESCE falls back to the transaction amount for
      // non-split rows), keeping the per-month total signed for the bar chart.
      const amountExpr = "COALESCE(splits.amount, transaction.amount)";

      // Split by currency and day so each part converts at its own date
      // before it joins its month; a bare SUM would add currencies together.
      // A split with a transfer line can sit in two parts, the line at its
      // transfer's rate and the other lines at theirs, so a split is counted
      // by id across its month rather than once per part.
      queryBuilder
        .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
        .addSelect("transaction.currencyCode", "currencyCode")
        .addSelect(DAY_TX_SQL, "txDate")
        .addSelect(`SUM(${amountExpr})`, "total")
        .addSelect(WHOLE_ROW_COUNT_SQL, "count")
        .addSelect(SPLIT_IDS_SQL, "splitIds")
        .addSelect(PROVISIONAL_COUNT_SQL, "provisionalCount")
        .groupBy("month")
        .addGroupBy("transaction.currencyCode")
        .addGroupBy(DAY_TX_SQL)
        .orderBy("month", "ASC");
      const defaultCurrency = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      byOwnRate(queryBuilder, "transaction", defaultCurrency, {
        transfers: true,
        splitAlias: "splits",
      });

      const rows = await queryBuilder.getRawMany();
      if (rows.length === 0) return [];

      // One currency across every row needs no conversion, so the totals stay
      // exact in that currency; otherwise they convert to the default.
      const codes = new Set(rows.map((r) => r.currencyCode as string));
      const reporting = codes.size === 1 ? [...codes][0] : defaultCurrency;
      const days = rows.map((r) => r.txDate as string).sort();
      const rates = await this.loadRateIndex(
        m,
        rows,
        reporting,
        days[0],
        days[days.length - 1],
      );
      const groups = this.foldGroups(rows, (r) => r.month, reporting, rates);
      const splitIds = new Map<string, Set<string>>();
      for (const row of rows) {
        const ids = splitIds.get(row.month) ?? new Set<string>();
        for (const id of (row.splitIds as string[] | null) ?? []) ids.add(id);
        splitIds.set(row.month, ids);
      }

      // `total` is null (with the converted part in `knownSubtotal`) while a
      // part of the month has no admissible rate.
      return groups
        .map((g) => ({
          month: g.first.month as string,
          currency: reporting,
          // The transactions page's monthly totals, not a report figure.
          ...totalFields(g.agg, FIAT_MONEY_DECIMALS),
          count: g.count + (splitIds.get(g.first.month)?.size ?? 0),
          provisionalCount: g.provisionalCount,
        }))
        .sort((a, b) => a.month.localeCompare(b.month));
    });
  }

  /**
   * Per-month foreign-transaction fee totals for one account, grouped by the
   * currency the transaction was paid in. Rows cover every non-void
   * foreign-entered transaction on the account (original_currency_code set).
   *
   * The fee is recovered per transaction: the bank's fee is folded into
   * `amount` (amount = round(originalAmount x exchangeRate) + fee, with
   * fee <= 0) for both ordinary and split transactions -- a split's category
   * lines simply sum to that fee-inclusive total -- so the fee is
   * round(originalAmount x exchangeRate) - amount in every case. A month whose
   * transactions predate the account's fee percentage sums to 0 rather than
   * being dropped. Fee amounts are returned positive in the account currency.
   */
  async getFxFeeSummary(
    userId: string,
    accountId: string,
  ): Promise<FxFeeMonthlySummaryRow[]> {
    return withScopedDb(this.dataSource, async (m) => {
      // The fee is in the account's currency: the converted base is re-derived
      // at that currency's precision, the one `applyFxConversion` rounded it
      // at when the row was written, so a coin account's fee is not the
      // four-place remainder of an eight-place amount.
      const account = await m.getRepository(Account).findOne({
        where: { id: accountId, userId },
        select: { id: true, currencyCode: true },
      });
      const places = account
        ? await loadCurrencyPlacesForRead(m, [account.currencyCode])
        : new Map<string, number>();
      const decimals = account
        ? moneyDecimalsForCode(places, account.currencyCode)
        : FIAT_MONEY_DECIMALS;
      const feeExpr = FX_FEE_AMOUNT_SQL;

      const feeRows = () =>
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.originalCurrencyCode IS NOT NULL")
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status != :voidStatus", {
            voidStatus: TransactionStatus.VOID,
          })
          .setParameter("feeDecimals", decimals);

      const rows = await feeRows()
        .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
        .addSelect("transaction.originalCurrencyCode", "currencyCode")
        .addSelect(`COALESCE(SUM(${feeExpr}), 0)`, "feeTotal")
        .addSelect("COUNT(DISTINCT transaction.id)", "count")
        .groupBy("month")
        .addGroupBy("transaction.originalCurrencyCode")
        .orderBy("month", "ASC")
        .addOrderBy("transaction.originalCurrencyCode", "ASC")
        .getRawMany();

      // The fee is in the account's currency; a reader in another currency
      // gets it converted per transaction at its own rate or its own date's
      // market rate, never a lifetime of fees at today's rate (issue #2106).
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const accountCurrency = account?.currencyCode;
      // Each row read once at the reporting currency's places: the Foreign
      // Currency Fees page's month and grand totals come from
      // `getFxFeeTotals`, which folds the fees before it reads them, so no
      // page adds these rows (docs/specs/report-rounding-and-aggregation.md
      // section 6, issue #2413).
      const convertedPlaces = await loadReportPlaces(m, reporting);
      const converted =
        accountCurrency && accountCurrency !== reporting && rows.length > 0
          ? await convertDatedRows(
              (sql, params) => m.query(sql, params),
              (
                await feeRows()
                  .select(
                    "TO_CHAR(transaction.transactionDate, 'YYYY-MM')",
                    "month",
                  )
                  .addSelect("transaction.originalCurrencyCode", "currencyCode")
                  .addSelect(DAY_TX_SQL, "txDate")
                  .addSelect("transaction.exchangeRate", "exchangeRate")
                  .addSelect(`COALESCE(SUM(${feeExpr}), 0)`, "feeTotal")
                  .groupBy("month")
                  .addGroupBy("transaction.originalCurrencyCode")
                  .addGroupBy(DAY_TX_SQL)
                  .addGroupBy("transaction.exchangeRate")
                  .getRawMany()
              ).map((row) => ({
                key: `${row.month}|${row.currencyCode}`,
                currencyCode: accountCurrency,
                txDate: row.txDate,
                originalCurrencyCode: row.currencyCode,
                exchangeRate: row.exchangeRate,
                amounts: { feeTotal: Number(row.feeTotal) || 0 },
              })),
              reporting,
              convertedPlaces,
              this.logger,
            )
          : null;

      return rows.map((row) => {
        const feeTotal = roundMoney(Number(row.feeTotal) || 0, decimals);
        return {
          month: row.month,
          currencyCode: row.currencyCode,
          feeTotal,
          count: Number(row.count) || 0,
          convertedCurrency: reporting,
          convertedFeeTotal:
            converted === null
              ? accountCurrency === reporting
                ? feeTotal
                : null
              : (converted.get(`${row.month}|${row.currencyCode}`)?.feeTotal ??
                null),
        };
      });
    });
  }

  /**
   * The Foreign Currency Fees report's totals across `accountIds`, narrowed to
   * the `currencyCodes` the transactions were paid in when given. The figures
   * are in the accounts' shared currency, else in the reporting currency with
   * each fee converted at its own transaction's rate or its own date's market
   * rate (issue #2106). Every fee is folded into its month's aggregate before
   * anything is read, so a quarter, a year, the grand total and an average are
   * each one rounding at the currency's places, never a sum of rounded rows
   * (docs/specs/report-rounding-and-aggregation.md rule 2, issue #2413). A
   * month's fees in one paid currency with no rate are left out whole, their
   * account's currency named and their transactions counted.
   */
  async getFxFeeTotals(
    userId: string,
    accountIds: readonly string[],
    currencyCodes?: readonly string[],
  ): Promise<FxFeeTotals> {
    return withScopedDb(this.dataSource, async (m) => {
      const accounts =
        accountIds.length === 0
          ? []
          : await m.getRepository(Account).find({
              where: { userId, id: In([...accountIds]) },
              select: { id: true, currencyCode: true },
              order: { id: "ASC" },
            });
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const accountCurrencies = new Set(accounts.map((a) => a.currencyCode));
      const currency =
        accountCurrencies.size === 1 ? [...accountCurrencies][0] : reporting;
      const currencyPlaces = await loadCurrencyPlacesForRead(m, [
        ...accountCurrencies,
      ]);
      const places = await loadReportPlaces(m, currency);

      const months = new Map<string, FxFeeMonthPart>();
      const partOf = (month: string): FxFeeMonthPart => {
        const part = months.get(month) ?? {
          sum: new FxAggregate(),
          count: 0,
          partial: false,
        };
        months.set(month, part);
        return part;
      };
      const addPart = (month: string, sum: FxAggregate, count: number) => {
        const part = partOf(month);
        part.sum.merge(sum);
        part.count += count;
      };
      const missing = new Set<string>();
      let excludedCount = 0;

      for (const account of accounts) {
        const decimals = moneyDecimalsForCode(
          currencyPlaces,
          account.currencyCode,
        );
        let query = m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
          .addSelect("transaction.originalCurrencyCode", "currencyCode")
          .addSelect(DAY_TX_SQL, "txDate")
          .addSelect("transaction.exchangeRate", "exchangeRate")
          .addSelect(`COALESCE(SUM(${FX_FEE_AMOUNT_SQL}), 0)`, "feeTotal")
          .addSelect("COUNT(DISTINCT transaction.id)", "count")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", {
            accountId: account.id,
          })
          .andWhere("transaction.originalCurrencyCode IS NOT NULL")
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status != :voidStatus", {
            voidStatus: TransactionStatus.VOID,
          })
          .setParameter("feeDecimals", decimals);
        if (currencyCodes && currencyCodes.length > 0) {
          query = query.andWhere(
            "transaction.originalCurrencyCode IN (:...currencyCodes)",
            { currencyCodes: [...currencyCodes] },
          );
        }
        const rows: {
          month: string;
          currencyCode: string;
          txDate: string;
          exchangeRate: string | null;
          feeTotal: string;
          count: string;
        }[] = await query
          .groupBy("month")
          .addGroupBy("transaction.originalCurrencyCode")
          .addGroupBy(DAY_TX_SQL)
          .addGroupBy("transaction.exchangeRate")
          .getRawMany();

        if (account.currencyCode === currency) {
          for (const row of rows) {
            const sum = new FxAggregate();
            sum.addConverted(Number(row.feeTotal) || 0);
            addPart(row.month, sum, Number(row.count) || 0);
          }
          continue;
        }

        const keyOf = (row: { month: string; currencyCode: string }) =>
          `${row.month}|${row.currencyCode}`;
        const counts = new Map<string, number>();
        for (const row of rows) {
          counts.set(
            keyOf(row),
            (counts.get(keyOf(row)) ?? 0) + (Number(row.count) || 0),
          );
        }
        const converted = await convertDatedRowAggregates(
          (sql, params) => m.query(sql, params),
          rows.map((row) => ({
            key: keyOf(row),
            currencyCode: account.currencyCode,
            txDate: row.txDate,
            originalCurrencyCode: row.currencyCode,
            exchangeRate: row.exchangeRate,
            amounts: { feeTotal: Number(row.feeTotal) || 0 },
          })),
          currency,
          this.logger,
        );
        for (const [key, count] of counts) {
          const sum = converted.get(key)?.feeTotal ?? null;
          if (sum === null) {
            missing.add(account.currencyCode);
            excludedCount += count;
            // The month stays a column, marked: its figure is a subtotal.
            partOf(key.split("|")[0]).partial = true;
            continue;
          }
          addPart(key.split("|")[0], sum, count);
        }
      }

      return {
        currency,
        ...foldFxFeeTotals(months, places),
        missingCurrencies: [...missing],
        excludedCount,
      };
    });
  }

  /**
   * The category a name a model wrote lands as on a row of `holder`
   * (`docs/specs/transfer-categories.md` section 4.4): resolved among the
   * categories that fit the row (INV-CATEGORY-001), and on a transfer a
   * Transfer category of that path first. `null` when the name names no
   * category; a name that names only a category the row cannot hold (a
   * Transfer category on an ordinary row) is refused with the reason.
   */
  async resolveLlmCategoryIdFor(
    userId: string,
    categoryName: string,
    holder: CategoryHolder,
  ): Promise<string | null> {
    const all = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
        select: ["id", "name", "parentId", "categoryType"],
      }),
    );
    // Exact names and paths resolve against every category first, so a path
    // that names one category means that one; the type the row prefers only
    // chooses between several candidates of one tier (spec section 4.4: on a
    // transfer, a Transfer category of that path first). A name still
    // ambiguous is unresolved, never guessed.
    const [found] = resolveCategoryNamePaths(all, [categoryName], {
      prefer: (c) =>
        holder === "transfer" ? isTransferCategory(c) : !isTransferCategory(c),
    });
    const named = found?.id ?? null;
    const category = named ? all.find((c) => c.id === named) : undefined;
    if (category && !categoryFits(category, holder)) {
      throw transferCategoryRefusal(category.name);
    }
    return named;
  }

  /**
   * Resolve LLM-supplied category names into the IDs used by the transaction
   * filters. The matching itself lives in `resolveCategoryNamePaths`
   * (`categories/category-name.util.ts`), which is also what qualifies the
   * names these tools *emit* -- one definition, so a name the model reads back
   * to us means the category we showed it.
   *
   * Accepts a bare name ("Dining Out"), a parent/child path in any separator
   * and spacing ("Food: Dining Out", "Food/Dining Out", "Food -> Dining Out"),
   * and forgives a wrong parent when the leaf is unique.
   *
   * Returns the matched category IDs (expanded to include descendants so a
   * filter on "Food" naturally catches its subcategories) plus any names we
   * could not match. Callers should treat any `unresolved` entry as a hard
   * failure rather than silently dropping the filter -- otherwise a mistyped
   * category yields "all transactions" instead of an honest error.
   *
   * A name matching several categories -- "Cell Phone" under both "Bills" and
   * "Business" -- is unresolved too, and `suggestions` carries the qualified
   * names it could have meant so the model can ask again precisely. Picking one
   * silently is what this replaces: the answer that comes back is about a
   * category the user never named, and nothing downstream can tell.
   */
  async resolveLlmCategoryIds(
    userId: string,
    categoryNames: string[],
  ): Promise<{
    categoryIds: string[];
    unresolved: string[];
    suggestions: string[];
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      if (categoryNames.length === 0) {
        return { categoryIds: [], unresolved: [], suggestions: [] };
      }

      const allCategories = await m.getRepository(Category).find({
        where: { userId },
        select: ["id", "name", "parentId"],
      });

      const resolutions = resolveCategoryNamePaths(
        allCategories,
        categoryNames,
      );
      const matched = resolutions
        .filter((r) => r.id !== null)
        .map((r) => r.id as string);
      const failures = resolutions.filter((r) => r.id === null);
      const unresolved = failures.map((r) => r.input);

      // For the first unmatched input: the qualified names it could have meant
      // when it was ambiguous, otherwise the closest names by edit distance, so
      // callers can surface a "did you mean?" instead of just "call
      // list_categories".
      const first = failures[0];
      const suggestions = !first
        ? []
        : first.candidates.length > 0
          ? first.candidates
          : suggestQualifiedCategoryNames(allCategories, first.input);

      if (matched.length === 0) {
        return { categoryIds: [], unresolved, suggestions };
      }

      const categoryIds = await getAllCategoryIdsWithChildren(
        m.getRepository(Category),
        userId,
        matched,
      );
      return { categoryIds, unresolved, suggestions };
    });
  }

  /**
   * Transaction summary + optional grouped breakdown shaped for LLM tools.
   * Shared by `ToolExecutorService.queryTransactions` and the MCP server's
   * `query_transactions` tool so both surfaces return the same shape.
   *
   * Callers resolve account/category names to IDs before calling.
   */
  async getLlmQueryTransactions(
    userId: string,
    input: LlmQueryTransactionsInput,
  ): Promise<LlmQueryTransactionsResult> {
    const summary = await this.getSummary(
      userId,
      input.accountIds,
      input.startDate,
      input.endDate,
      input.categoryIds,
      undefined,
      input.searchText,
      undefined,
      undefined,
      true,
      true,
    );
    const converted = await this.getConvertedFlowTotals(userId, {
      accountIds: input.accountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      categoryIds: input.categoryIds,
      search: input.searchText,
    });

    let breakdown: LlmBreakdown | undefined;
    if (input.groupBy) {
      breakdown = await this.getLlmGroupedBreakdown(
        userId,
        input.startDate,
        input.endDate,
        input.groupBy,
        input.direction,
        input.accountIds,
        input.categoryIds,
        input.searchText,
      );
    }

    const result: LlmQueryTransactionsResult = {
      ...this.convertedFlowFields(converted, breakdown?.fx),
      transactionCount: summary.transactionCount,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      result.byCurrency = summary.byCurrency;
    }

    if (breakdown !== undefined) {
      result.breakdown = breakdown.rows;
    }

    return result;
  }

  /**
   * Unified transaction summary for the `list_transactions` tool. Composes the
   * existing building blocks: the income/expense/net + per-currency totals from
   * {@link getSummary} (transfers and investment-linked rows excluded so the
   * totals answer "how much did I spend/earn"), an optional grouped breakdown
   * via {@link getLlmGroupedBreakdown} when `groupBy` is a real grouping (not
   * "none"), and an optional per-account transfer rollup via
   * {@link getTransfersByAccount} when `transfersOnly` is set.
   *
   * The headline totals are not `getSummary`'s: that sums each currency's
   * numbers as they stand, so 1,000 USD joined 4,000 PLN as 5,000. They come
   * from {@link getConvertedFlowTotals}, each row converted at the rate for its
   * own date into the user's default currency (`totalsCurrency`), and are
   * `null` while a pair has no rate. `byCurrency` stays the unconverted view.
   *
   * The RAW transaction list is NOT produced here -- tool adapters fetch it
   * separately via `TransactionsService.getLlmTransactionRows` only when asked.
   *
   * Callers resolve account/category/payee names to IDs before calling. Shared
   * by the AI Assistant tool executor and the MCP server so both surfaces
   * return the same shape.
   */
  async getLlmListTransactions(
    userId: string,
    input: LlmListTransactionsInput,
  ): Promise<LlmListTransactionsResult> {
    const groupBy: LlmListGroupBy = input.groupBy ?? "none";

    const summary = await this.getSummary(
      userId,
      input.accountIds,
      input.startDate,
      input.endDate,
      input.categoryIds,
      input.payeeIds,
      input.searchText,
      input.minAmount,
      input.maxAmount,
      true,
      true,
    );
    const converted = await this.getConvertedFlowTotals(userId, {
      accountIds: input.accountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      categoryIds: input.categoryIds,
      payeeIds: input.payeeIds,
      search: input.searchText,
      amountFrom: input.minAmount,
      amountTo: input.maxAmount,
    });

    let breakdown: LlmBreakdown | undefined;
    if (groupBy !== "none") {
      breakdown = await this.getLlmGroupedBreakdown(
        userId,
        input.startDate,
        input.endDate,
        groupBy,
        input.direction,
        input.accountIds,
        input.categoryIds,
        input.searchText,
        input.payeeIds,
        input.minAmount,
        input.maxAmount,
      );
    }

    const result: LlmListTransactionsResult = {
      ...this.convertedFlowFields(converted, breakdown?.fx),
      transactionCount: summary.transactionCount,
      groupedBy: groupBy,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      result.byCurrency = summary.byCurrency;
    }

    if (breakdown !== undefined) {
      result.breakdown = breakdown.rows;
    }

    if (input.transfersOnly) {
      result.transfers = await this.getTransfersByAccount(
        userId,
        input.startDate,
        input.endDate,
        input.accountIds,
      );
    }

    return result;
  }

  /**
   * Income and expense totals over the same rows (the same filtered query, so
   * the same filters) as {@link getSummary}, each row converted into the user's
   * default currency at the rate it settled at where that reaches the default
   * currency (INV-FX-002), else at the market rate for its own transaction date.
   *
   * Grouped by currency, day and own rate ({@link byOwnRate}) so a foreign row is
   * priced as the reports price it and the market rates load once for the window
   * (`buildRateIndex`), inside this transaction.
   * Same currency and zero need no rate; a row whose pair has no admissible rate
   * is recorded in the aggregate, never folded in at 1:1.
   */
  private async getConvertedFlowTotals(
    userId: string,
    filters: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      categoryIds?: string[];
      payeeIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      /** Default true: the totals answer "how much did I spend/earn". */
      excludeTransfers?: boolean;
    },
  ): Promise<ConvertedFlowTotals> {
    const { excludeTransfers = true, ...scope } = filters;
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const qb = await this.createFilteredAnalyticsQuery(m, userId, {
        ...scope,
        excludeInvestmentLinked: true,
        excludeTransfers,
      });

      const amountExpr = "COALESCE(splits.amount, transaction.amount)";
      const dayExpr = "TO_CHAR(transaction.transactionDate, 'YYYY-MM-DD')";
      qb.select("transaction.currencyCode", "currencyCode")
        .addSelect(dayExpr, "txDate")
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} > 0 THEN ${amountExpr} ELSE 0 END)`,
          "totalIncome",
        )
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} < 0 THEN ABS(${amountExpr}) ELSE 0 END)`,
          "totalExpenses",
        )
        .addSelect(PROVISIONAL_COUNT_SQL, "provisionalCount")
        .groupBy("transaction.currencyCode")
        .addGroupBy(dayExpr);
      byOwnRate(qb, "transaction", reporting, {
        transfers: !excludeTransfers,
        splitAlias: "splits",
      });

      const rows = await qb.getRawMany();
      const rates = await this.loadRateIndex(
        m,
        rows,
        reporting,
        filters.startDate,
        filters.endDate,
      );

      const income = new FxAggregate();
      const expenses = new FxAggregate();
      let provisionalCount = 0;
      for (const row of rows) {
        const incomeIn = addDatedAmount(
          income,
          Number(row.totalIncome) || 0,
          row,
          reporting,
          rates,
          this.logger,
        );
        const expensesIn = addDatedAmount(
          expenses,
          Number(row.totalExpenses) || 0,
          row,
          reporting,
          rates,
          this.logger,
        );
        // A part's legs are in the known totals only when it converted.
        if (incomeIn && expensesIn) {
          provisionalCount += Number(row.provisionalCount) || 0;
        }
      }
      return {
        income,
        expenses,
        provisionalCount,
        totalsCurrency: reporting,
        places: await loadReportPlaces(m, reporting),
      };
    });
  }

  /**
   * The income, expense and net totals of a window in the user's default
   * currency, for a surface that shows a month or a recent-activity summary
   * (the MCP `financial-summary` and `recent-transactions` resources). The same
   * rows and filters as {@link getSummary} with investment-linked cash excluded;
   * `excludeTransfers` follows the caller. Same fields, same withholding, as the
   * `list_transactions` totals.
   */
  async getLlmFlowTotals(
    userId: string,
    filters: { startDate: string; endDate: string; excludeTransfers?: boolean },
  ): Promise<LlmConvertedFlowFields> {
    return this.convertedFlowFields(
      await this.getConvertedFlowTotals(userId, filters),
    );
  }

  /**
   * The totals fields of a list/query result. All three totals are withheld
   * (`null`) when any component, in the totals or in a breakdown beside them,
   * could not be converted; the known parts and the pairs to repair are always
   * there.
   */
  private convertedFlowFields(
    converted: ConvertedFlowTotals,
    breakdownFx?: FxAggregate,
  ): LlmConvertedFlowFields {
    const all = new FxAggregate();
    all.merge(converted.income);
    all.merge(converted.expenses);
    if (breakdownFx) all.merge(breakdownFx);
    const fxComplete = all.isComplete;
    // Each figure rounded once at the reporting currency's places, as the
    // reports round theirs (docs/specs/report-rounding-and-aggregation.md
    // section 6).
    const { places } = converted;
    const income = converted.income.knownSubtotalAt(places);
    const expenses = converted.expenses.knownSubtotalAt(places);
    return {
      totalIncome: fxComplete ? income : null,
      totalExpenses: fxComplete ? expenses : null,
      // Income less expenses before either is rounded, rounded once: the
      // difference of the two readings could sit a unit off the summary's
      // own net (rule 2).
      netCashFlow: fxComplete
        ? FxAggregate.difference(
            converted.income,
            converted.expenses,
          ).knownSubtotalAt(places)
        : null,
      knownIncomeSubtotal: income,
      knownExpensesSubtotal: expenses,
      totalsCurrency: converted.totalsCurrency,
      fxComplete,
      missingRatePairs: all.missingPairs,
      provisionalCount: converted.provisionalCount,
    };
  }

  /** Every stored rate the rows' foreign currencies can need, loaded once. */
  private loadRateIndex(
    m: EntityManager,
    rows: RawGroupRow[],
    reporting: string,
    startDate: string,
    endDate: string,
  ): Promise<RateIndex> {
    // Only a part the market rate converts needs the history: not one in the
    // reporting currency, nor one that settled into it at its own rate.
    const foreign = new Set<string>();
    for (const row of rows) {
      if (!row.currencyCode || row.currencyCode === reporting) continue;
      const basis = partRateBasis(
        row,
        row.currencyCode,
        row.txDate ?? startDate,
        reporting,
      );
      if (toOwnRate(basis.own_rate) === null) foreign.add(row.currencyCode);
    }
    return buildRateIndex(
      (sql, params) => m.query(sql, params),
      foreign,
      reporting,
      startDate,
      endDate,
    );
  }

  /**
   * Fold per-(group, currency, day) rows into one converted aggregate per
   * group. `keyOf` names the group; the first row seen stands for its label
   * columns. A row's `provisionalCount`, where the read selects one, counts
   * only when its amount converted into the aggregate.
   */
  private async loadReportCategories(m: EntityManager, userId: string) {
    const rows = await m.getRepository(Category).find({
      where: { userId },
      select: ["id", "name", "parentId", "categoryType"],
    });
    return {
      names: qualifiedNamesById(rows),
      typeById: new Map(rows.map((row) => [row.id, categoryTypeOf(row)])),
    };
  }

  private foldGroups(
    rows: RawGroupRow[],
    keyOf: (row: RawGroupRow) => string,
    reporting: string,
    rates: RateIndex,
  ): FoldedGroup[] {
    const groups = new Map<string, FoldedGroup>();
    for (const row of rows) {
      const key = keyOf(row);
      let group = groups.get(key);
      if (!group) {
        group = {
          first: row,
          agg: new FxAggregate(),
          count: 0,
          provisionalCount: 0,
        };
        groups.set(key, group);
      }
      group.count += Number(row.count) || 0;
      const converted = addDatedAmount(
        group.agg,
        Number(row.total) || 0,
        row,
        reporting,
        rates,
        this.logger,
      );
      if (converted) {
        group.provisionalCount += Number(row.provisionalCount) || 0;
      }
    }
    return [...groups.values()];
  }

  private async getLlmGroupedBreakdown(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmQueryGroupBy,
    direction: LlmQueryDirection | undefined,
    accountIds?: string[],
    categoryIds?: string[],
    searchText?: string,
    payeeIds?: string[],
    minAmount?: number,
    maxAmount?: number,
  ): Promise<LlmBreakdown> {
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      // Each group's figure is read once at the reporting currency's places
      // (docs/specs/report-rounding-and-aggregation.md section 6).
      const places = await loadReportPlaces(m, reporting);
      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "breakdownAccount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL");

      joinSplitsForAnalytics(qb);
      applyInvestmentTransactionFilters(qb, "breakdownAccount", "t");

      // Select the posting population before grouping it. In particular, a
      // refund in an expense category keeps its sign even in a later month.
      if (direction === "expenses") {
        qb.innerJoin(
          Category,
          "expenseCategory",
          `expenseCategory.id = ${SPLIT_CATEGORY_ID} AND expenseCategory.userId = t.userId`,
        )
          .andWhere(categoryTypeIs("expenseCategory", "expense"))
          .andWhere(`${SPLIT_AMOUNT} <> 0`);
      } else if (direction === "outgoing") {
        qb.andWhere(`${SPLIT_AMOUNT} < 0`);
      } else if (direction === "income") {
        qb.andWhere(
          groupBy === "category"
            ? `${SPLIT_AMOUNT} <> 0`
            : `${SPLIT_AMOUNT} > 0`,
        );
      }

      const amount =
        direction === "expenses" || direction === "outgoing"
          ? `-${SPLIT_AMOUNT}`
          : groupBy === "category"
            ? SPLIT_AMOUNT
            : `ABS(${SPLIT_AMOUNT})`;

      if (accountIds && accountIds.length > 0) {
        qb.andWhere("t.accountId IN (:...accountIds)", { accountIds });
      }

      if (categoryIds && categoryIds.length > 0) {
        qb.andWhere(
          "COALESCE(ts.categoryId, t.categoryId) IN (:...categoryIds)",
          { categoryIds },
        );
      }

      if (payeeIds && payeeIds.length > 0) {
        qb.andWhere("t.payeeId IN (:...payeeIds)", { payeeIds });
      }

      if (minAmount !== undefined) {
        qb.andWhere(`${SPLIT_AMOUNT} >= :minAmount`, { minAmount });
      }

      if (maxAmount !== undefined) {
        qb.andWhere(`${SPLIT_AMOUNT} <= :maxAmount`, { maxAmount });
      }

      // The raw string, escaped once inside the builder, so these rows and
      // the summary above read the search identically (INV-SEARCH-005).
      await applyTransactionSearch(m, qb, searchText, {
        userId,
        transaction: "t",
        splits: "ts",
        grain: "split",
        paramPrefix: "srch",
      });

      // Every group is also split by currency and day, so each part can be
      // converted at its own date before it is added to its group.
      const byCurrencyAndDay = () =>
        byOwnRate(
          qb
            .addSelect("t.currencyCode", "currencyCode")
            .addSelect(DAY_SQL, "txDate")
            .addGroupBy("t.currencyCode")
            .addGroupBy(DAY_SQL),
          "t",
          reporting,
        );
      const fx = new FxAggregate();
      const finish = (groups: FoldedGroup[]) => {
        for (const g of groups) fx.merge(g.agg);
      };

      switch (groupBy) {
        case "category": {
          // Grouping is on the category id, not the display name: "Cell Phone"
          // exists under both "Bills" and "Business" for plenty of users, and
          // grouping by name merged the two into one row whose id was an
          // arbitrary member -- a total the user cannot reconcile against
          // either category, deep-linking to one of them. The id is exact now,
          // and the label carries the parent so two rows named "Cell Phone" can
          // be told apart. The "Uncategorized" bucket groups on a NULL id.
          qb.select(`${SPLIT_CATEGORY_ID}::text`, "categoryId")
            .addSelect(`SUM(${amount})`, "total")
            .addSelect("COUNT(*)", "count")
            .groupBy(`${SPLIT_CATEGORY_ID}::text`);
          byCurrencyAndDay();

          const rows = await qb.getRawMany();
          const rates = await this.loadRateIndex(
            m,
            rows,
            reporting,
            startDate,
            endDate,
          );
          const names = await loadQualifiedCategoryNames(m, userId);
          let groups = this.foldGroups(
            rows,
            (r) => r.categoryId ?? "",
            reporting,
            rates,
          );
          if (direction === "income") {
            // Salary +5000 / -200 correction is 4800 income, like the report.
            groups = groups.filter((g) => g.agg.sign > 0 || !g.agg.isComplete);
          }
          finish(groups);
          // Without a direction the figure is the magnitude of the net.
          const shown = (g: FoldedGroup) => {
            const f = totalFields(g.agg, places);
            if (direction) return f;
            return {
              total: f.total === null ? null : Math.abs(f.total),
              ...(f.knownSubtotal !== undefined && {
                knownSubtotal: Math.abs(f.knownSubtotal),
              }),
            };
          };
          return {
            fx,
            rows: byKnownSubtotal(
              groups.map((g) => ({
                category: g.first.categoryId
                  ? (names.get(g.first.categoryId) ?? UNKNOWN_CATEGORY_LABEL)
                  : UNCATEGORIZED_LABEL,
                categoryId: g.first.categoryId ?? null,
                ...shown(g),
                count: g.count,
              })),
            ),
          };
        }

        case "payee": {
          // A linked payee may have no stored transaction name. Free-text
          // names and the anonymous catch-all keep their existing labels.
          const label = "COALESCE(t.payeeName, breakdownPayee.name, 'Unknown')";
          qb.leftJoin(
            "t.payee",
            "breakdownPayee",
            "breakdownPayee.userId = t.userId",
          )
            .select(label, "label")
            .addSelect("MIN(CAST(t.payeeId AS text))", "payeeId")
            .addSelect(`SUM(${amount})`, "total")
            .addSelect("COUNT(DISTINCT t.id)", "count")
            .groupBy(label);
          byCurrencyAndDay();

          const rows = await qb.getRawMany();
          const rates = await this.loadRateIndex(
            m,
            rows,
            reporting,
            startDate,
            endDate,
          );
          // The per-day rows each carry their own MIN; the group's is the
          // least of them, as the single-row query returned before.
          const payeeIds = new Map<string, string>();
          for (const r of rows) {
            const seen = payeeIds.get(r.label);
            if (r.payeeId && (seen === undefined || r.payeeId < seen)) {
              payeeIds.set(r.label, r.payeeId);
            }
          }
          const groups = this.foldGroups(
            rows,
            (r) => r.label,
            reporting,
            rates,
          );
          finish(groups);
          return {
            fx,
            rows: enforcePayeeAggregationThreshold(
              groups.map((g) => ({
                payee: g.first.label,
                payeeId: payeeIds.get(g.first.label) ?? null,
                agg: g.agg,
                count: g.count,
              })),
              places,
            ),
          };
        }

        case "year":
        case "month":
        case "week": {
          const periodExpr =
            groupBy === "year"
              ? "TO_CHAR(t.transactionDate, 'YYYY')"
              : groupBy === "month"
                ? "TO_CHAR(t.transactionDate, 'YYYY-MM')"
                : "TO_CHAR(DATE_TRUNC('week', t.transactionDate), 'YYYY-MM-DD')";
          qb.select(periodExpr, "period")
            .addSelect(`SUM(${amount})`, "total")
            .addSelect("COUNT(*)", "count")
            .groupBy(periodExpr);
          byCurrencyAndDay();

          const rows = await qb.getRawMany();
          const rates = await this.loadRateIndex(
            m,
            rows,
            reporting,
            startDate,
            endDate,
          );
          const groups = this.foldGroups(
            rows,
            (r) => r.period,
            reporting,
            rates,
          );
          finish(groups);
          return {
            fx,
            rows: groups
              .sort((a, b) => (a.first.period < b.first.period ? -1 : 1))
              .map((g) => ({
                [groupBy]: g.first.period,
                ...totalFields(g.agg, places),
                count: g.count,
              })),
          };
        }
      }
    });
  }

  /**
   * Compare two date ranges side-by-side, grouped by category or payee.
   * Shared by `ToolExecutorService.comparePeriods` and the MCP tool.
   *
   * Every row is converted into the user's default currency (`totalsCurrency`)
   * at the rate for its own date before it joins its group, so the periods are
   * comparable. A period whose rows include a pair with no rate has a `null`
   * total, which makes `totalChange` and `totalChangePercent` `null` too: the
   * change between a total and a subtotal is not a change. When both periods
   * hold only same-currency rows the figures are as they always were.
   *
   * `totalChangePercent` is `0` when the first period's total is `0`, as it
   * always was; a row's own `changePercent` is `100` for a label new in the
   * second period.
   */
  async getLlmPeriodComparison(
    userId: string,
    input: LlmPeriodComparisonInput,
  ): Promise<LlmPeriodComparisonResult> {
    const groupBy = input.groupBy ?? "category";
    const direction = input.direction ?? "expenses";

    const [period1, period2] = await Promise.all([
      this.getComparisonPeriodData(
        userId,
        input.period1Start,
        input.period1End,
        groupBy,
        direction,
      ),
      this.getComparisonPeriodData(
        userId,
        input.period2Start,
        input.period2End,
        groupBy,
        direction,
      ),
    ]);

    const allLabels = new Set([
      ...period1.items.map((i) => i.label),
      ...period2.items.map((i) => i.label),
    ]);

    // Each figure is read once at the reporting currency's places, and each
    // change is the difference of the two periods' aggregates read once: the
    // difference of the two readings can sit a cent off the exact change
    // (docs/specs/report-rounding-and-aggregation.md rule 4, section 6). A
    // percentage divides the unrounded values (rule 8), and only over a first
    // period that reads as money: dust shown as 0.00 has no percentage.
    const places = await reportPlacesOf(
      this.dataSource,
      period1.totalsCurrency,
    );
    const p1Map = new Map(period1.items.map((i) => [i.label, i.agg]));
    const p2Map = new Map(period2.items.map((i) => [i.label, i.agg]));
    const none = new FxAggregate();
    const percentOf = (difference: FxAggregate, base: FxAggregate): number =>
      percentToTwoPlaces(difference.unroundedSubtotal / base.unroundedSubtotal);

    const noSpendingBase = (base: FxAggregate, current: FxAggregate) =>
      direction === "expenses" &&
      groupBy === "category" &&
      (base.sign < 0 ||
        (base.knownSubtotalAt(places) === 0 && current.sign < 0));

    const comparison = Array.from(allLabels).map((label) => {
      const p1 = p1Map.get(label) ?? none;
      const p2 = p2Map.get(label) ?? none;
      const difference = FxAggregate.difference(p2, p1);
      const p1Amount = p1.knownSubtotalAt(places);
      const p2Amount = p2.knownSubtotalAt(places);
      const change = difference.knownSubtotalAt(places);
      const changePercent = noSpendingBase(p1, p2)
        ? null
        : p1Amount !== 0
          ? percentOf(difference, p1)
          : p2Amount !== 0
            ? 100
            : 0;

      return {
        label,
        period1Amount: p1Amount,
        period2Amount: p2Amount,
        change,
        changePercent,
      };
    });

    comparison.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    const both = new FxAggregate();
    both.merge(period1.total);
    both.merge(period2.total);
    const p1Total = period1.total.knownSubtotalAt(places);
    const p2Total = period2.total.knownSubtotalAt(places);
    const fxComplete = both.isComplete;
    const totalDifference = FxAggregate.difference(
      period2.total,
      period1.total,
    );
    const totalChange = fxComplete
      ? totalDifference.knownSubtotalAt(places)
      : null;
    const totalChangePercent =
      totalChange === null || noSpendingBase(period1.total, period2.total)
        ? null
        : p1Total !== 0
          ? percentOf(totalDifference, period1.total)
          : 0;

    return {
      period1: {
        start: input.period1Start,
        end: input.period1End,
        total: period1.total.totalAt(places),
        knownSubtotal: p1Total,
        provisionalCount: period1.provisionalCount,
      },
      period2: {
        start: input.period2Start,
        end: input.period2End,
        total: period2.total.totalAt(places),
        knownSubtotal: p2Total,
        provisionalCount: period2.provisionalCount,
      },
      totalChange,
      totalChangePercent,
      totalsCurrency: period1.totalsCurrency,
      fxComplete,
      missingRatePairs: both.missingPairs,
      comparison,
    };
  }

  private async getComparisonPeriodData(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmComparisonGroupBy,
    direction: LlmComparisonDirection,
  ): Promise<ComparisonPeriodData> {
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "periodAccount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL");

      joinSplitsForAnalytics(qb);
      applyInvestmentTransactionFilters(qb, "periodAccount", "t");

      // Expenses are the signed sum over rows of both signs, negated, so a
      // refund in a category reduces what was spent there instead of being
      // dropped. Classified expense categories keep a zero or credit balance.
      // Income keeps its positive
      // rows and "both" the magnitude of every row.
      let amountExpr: string;
      if (direction === "expenses") {
        amountExpr = `-${SPLIT_AMOUNT}`;
        qb.andWhere(`${SPLIT_AMOUNT} <> 0`);
      } else if (direction === "income") {
        amountExpr = SPLIT_AMOUNT;
        qb.andWhere(`${SPLIT_AMOUNT} > 0`);
      } else {
        amountExpr = `ABS(${SPLIT_AMOUNT})`;
      }

      if (groupBy === "payee") {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect(`SUM(${amountExpr})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName");
      } else {
        // Same rule as the grouped breakdown: identity is the category id, and
        // the label carries the parent so a comparison never puts two different
        // "Cell Phone" categories in one row.
        qb.select(`${SPLIT_CATEGORY_ID}::text`, "categoryId")
          .addSelect(`SUM(${amountExpr})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(`${SPLIT_CATEGORY_ID}::text`);
      }
      // Each part is converted at its own date before it joins its group.
      // Transfers are outside this read, so its provisional count is 0 until
      // that changes; it is counted, not assumed.
      qb.addSelect("t.currencyCode", "currencyCode")
        .addSelect(provisionalCountSql("t", "ts"), "provisionalCount")
        .addSelect(DAY_SQL, "txDate")
        .addGroupBy("t.currencyCode")
        .addGroupBy(DAY_SQL);
      byOwnRate(qb, "t", reporting);

      const rows = await qb.getRawMany();
      const rates = await this.loadRateIndex(
        m,
        rows,
        reporting,
        startDate,
        endDate,
      );
      const categories =
        groupBy === "category"
          ? await this.loadReportCategories(m, userId)
          : undefined;
      let groups = this.foldGroups(
        rows,
        (r) => (groupBy === "payee" ? r.label : (r.categoryId ?? "")),
        reporting,
        rates,
      );
      if (direction === "expenses") {
        groups = groups.filter(
          (g) =>
            !g.agg.isComplete ||
            includesSpendingCategory(
              g.agg.sign,
              categories?.typeById.get(g.first.categoryId),
            ),
        );
      }
      let items: ComparisonItem[] = groups.map((g) => ({
        label:
          groupBy === "payee"
            ? g.first.label
            : g.first.categoryId
              ? (categories?.names.get(g.first.categoryId) ??
                UNKNOWN_CATEGORY_LABEL)
              : UNCATEGORIZED_LABEL,
        agg: g.agg,
        count: g.count,
        provisionalCount: g.provisionalCount,
      }));

      if (groupBy === "payee") {
        const above = items.filter((i) => i.count >= MIN_AGGREGATION_COUNT);
        const below = items.filter((i) => i.count < MIN_AGGREGATION_COUNT);
        if (below.length > 0) {
          const other = new FxAggregate();
          for (const i of below) other.merge(i.agg);
          above.push({
            label: "Other (aggregated)",
            agg: other,
            count: below.reduce((s, i) => s + i.count, 0),
            provisionalCount: below.reduce((s, i) => s + i.provisionalCount, 0),
          });
        }
        items = above;
      }

      const total = new FxAggregate();
      for (const i of items) total.merge(i.agg);
      return {
        totalsCurrency: reporting,
        items,
        total,
        provisionalCount: items.reduce((s, i) => s + i.provisionalCount, 0),
      };
    });
  }

  /**
   * Detect recurring (subscription-like) charges for a user over a date range.
   * Shared by the AI insights and forecast aggregators so both compute
   * recurring charges identically. Groups debit transactions by payee/category,
   * keeps groups seen at least 3 times, and classifies their cadence. Pass
   * `uncategorizedLabel` to substitute a label for charges with no category
   * (the forecast aggregator uses "Uncategorized"; insights leaves it null).
   *
   * `accountId` narrows detection to one account's own rows, which is what a
   * per-account panel is actually asking about: a charge that recurs on another
   * card is not a recurring charge on this one. It is a filter on the *rows the
   * cadence is measured from*, not a post-filter on the result, so the >= 3
   * threshold and the amounts are the account's own. The caller must authorize
   * the account first -- this method trusts the id it is handed, exactly as it
   * trusts `userId`.
   *
   * A charge is detected per currency, so its amounts are one currency's
   * (`currencyCode`). `reportingCurrency` adds `converted`: the latest and the
   * previous occurrence in that currency, each at its own rate and date, for a
   * caller that sets them beside reporting-currency figures (issue #2155).
   */
  async getRecurringCharges(
    userId: string,
    startDate: string,
    endDate: string,
    options: {
      uncategorizedLabel?: string;
      payeeIds?: string[];
      accountId?: string;
      reportingCurrency?: string;
    } = {},
  ): Promise<RecurringCharge[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const categoryNameSelect = options.uncategorizedLabel
        ? "COALESCE(cat.name, :uncategorizedLabel)"
        : "cat.name";

      // A transaction linked to a payee record carries payeeId with a NULL
      // payeeName, so resolve the display name through the payee relation and
      // fall back to the free-text name (e.g. imported rows).
      const payeeNameExpr = "COALESCE(chargePayee.name, t.payeeName)";

      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.category", "cat")
        .leftJoin("t.payee", "chargePayee")
        .select(payeeNameExpr, "payeeName")
        .addSelect("chargePayee.id", "payeeId")
        .addSelect(categoryNameSelect, "categoryName")
        .addSelect("cat.id", "categoryId")
        // A split parent's own amount is the sum of every line, so the charge
        // has to be the ordinary part -- otherwise this answers 560 where the
        // built-in Recurring Expenses report answers 60 for the same rows.
        .addSelect(
          `ARRAY_AGG(ABS(${RECURRING_REPORTABLE_AMOUNT}) ORDER BY t.transactionDate ASC, t.id ASC)`,
          "amounts",
        )
        .addSelect(
          "ARRAY_AGG(TO_CHAR(t.transactionDate, 'YYYY-MM-DD') ORDER BY t.transactionDate ASC, t.id ASC)",
          "dates",
        )
        .addSelect("COUNT(*)", "txnCount")
        .addSelect("t.currencyCode", "currencyCode")
        // Each occurrence's own rate columns, in the order of `amounts`, so it
        // converts as the reports convert it. Every array orders by date and
        // then id: two charges on one day must not swap rates between arrays.
        .addSelect(
          "ARRAY_AGG(t.originalCurrencyCode ORDER BY t.transactionDate ASC, t.id ASC)",
          "originalCurrencies",
        )
        .addSelect(
          "ARRAY_AGG(t.exchangeRate ORDER BY t.transactionDate ASC, t.id ASC)",
          "exchangeRates",
        )
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere(`${RECURRING_REPORTABLE_AMOUNT} < 0`)
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL")
        .andWhere("(t.payeeId IS NOT NULL OR t.payeeName IS NOT NULL)")
        // Exclude investment-linked cash debits so regular BUY activity
        // isn't flagged as a subscription-like "recurring charge".
        .andWhere(investmentLinkedTransactionExclusion("t"))
        .setParameters(
          options.uncategorizedLabel
            ? { uncategorizedLabel: options.uncategorizedLabel }
            : {},
        )
        .groupBy(payeeNameExpr)
        .addGroupBy("chargePayee.id")
        .addGroupBy("cat.name")
        .addGroupBy("cat.id")
        // Amounts in two currencies are not one series: a price "change" from
        // 15.99 USD to 21.50 CAD is a unit change (issue #2155).
        .addGroupBy("t.currencyCode")
        .having("COUNT(*) >= 3")
        .orderBy("COUNT(*)", "DESC");

      if (options.payeeIds && options.payeeIds.length > 0) {
        qb.andWhere("t.payeeId IN (:...payeeIds)", {
          payeeIds: options.payeeIds,
        });
      }

      if (options.accountId) {
        qb.andWhere("t.accountId = :accountId", {
          accountId: options.accountId,
        });
      }

      const rows = await qb.getRawMany();
      // Qualified so a recurring charge on "Business: Cell Phone" is not
      // reported against "Bills: Cell Phone" in an insight or a forecast.
      const names = await loadQualifiedCategoryNames(m, userId);

      const charges = rows
        .map((r) => {
          const amounts: number[] = (r.amounts || []).map(Number);
          const dates: string[] = r.dates || [];
          const frequency = detectFrequency(dates);
          const currentAmount =
            amounts.length > 0 ? amounts[amounts.length - 1] : 0;
          const previousAmount =
            amounts.length > 1 ? amounts[amounts.length - 2] : currentAmount;

          return {
            charge: {
              payeeName: r.payeeName,
              payeeId: r.payeeId || null,
              currencyCode: r.currencyCode,
              amounts,
              dates,
              frequency,
              currentAmount,
              previousAmount,
              categoryName: r.categoryId
                ? (names.get(r.categoryId) ?? r.categoryName)
                : r.categoryName,
              categoryId: r.categoryId || null,
            } as RecurringCharge,
            originalCurrencies: (r.originalCurrencies || []) as Array<
              string | null
            >,
            exchangeRates: (r.exchangeRates || []) as Array<
              string | number | null
            >,
          };
        })
        .filter((r) => r.charge.frequency !== "irregular");

      if (!options.reportingCurrency) return charges.map((r) => r.charge);
      return this.convertRecurringCharges(
        m,
        charges,
        options.reportingCurrency,
      );
    });
  }

  /**
   * Each charge with its latest and previous occurrence converted into
   * `reporting` (`convertDatedRows`: the row's own rate, else the market rate
   * on its date), or `null` where that occurrence has no rate.
   */
  private async convertRecurringCharges(
    m: EntityManager,
    charges: ReadonlyArray<{
      charge: RecurringCharge;
      originalCurrencies: Array<string | null>;
      exchangeRates: Array<string | number | null>;
    }>,
    reporting: string,
  ): Promise<RecurringCharge[]> {
    const occurrence = (
      entry: (typeof charges)[number],
      index: number,
      key: string,
    ) => ({
      key,
      currencyCode: entry.charge.currencyCode,
      txDate: entry.charge.dates[index],
      originalCurrencyCode: entry.originalCurrencies[index] ?? null,
      exchangeRate: entry.exchangeRates[index] ?? null,
      amounts: { amount: entry.charge.amounts[index] },
    });
    const parts = charges.flatMap((entry, i) => {
      const last = entry.charge.amounts.length - 1;
      return [
        occurrence(entry, last, `${i}:current`),
        occurrence(entry, Math.max(last - 1, 0), `${i}:previous`),
      ];
    });
    const converted = await convertDatedRows(
      (sql, params) => m.query(sql, params),
      parts,
      reporting,
      // One occurrence each, for the insights and forecast prompts.
      FIAT_MONEY_DECIMALS,
      this.logger,
    );
    return charges.map((entry, i) => {
      return {
        ...entry.charge,
        converted: {
          currency: reporting,
          currentAmount: converted.get(`${i}:current`)?.amount ?? null,
          previousAmount: converted.get(`${i}:previous`)?.amount ?? null,
        },
      };
    });
  }
}

/** One day's SQL, for the `t` alias: the date a row is converted at. */
const DAY_SQL = "TO_CHAR(t.transactionDate, 'YYYY-MM-DD')";
const DAY_TX_SQL = "TO_CHAR(transaction.transactionDate, 'YYYY-MM-DD')";

/**
 * A part's transaction count over the base query's splits join, in two
 * columns: the whole rows, which lie in one part each, and the ids of the
 * splits, whose lines can lie in two (a transfer line at its transfer's rate,
 * the other lines at theirs), so a fold counts each split once by id.
 */
const WHOLE_ROW_COUNT_SQL =
  "COUNT(DISTINCT transaction.id) FILTER (WHERE splits.id IS NULL)";
const SPLIT_IDS_SQL =
  "ARRAY_AGG(DISTINCT transaction.id::text) FILTER (WHERE splits.id IS NOT NULL)";

/**
 * A part's provisional transfer legs (`amountIsProvisional`, design section
 * 6, P5) over the same join: whole rows only, since a split line is never
 * provisional, so each lies in one part and the parts' counts add up. VOID
 * rows are already outside every analytics read.
 */
const PROVISIONAL_COUNT_SQL = provisionalCountSql("transaction", "splits");

/** {@link PROVISIONAL_COUNT_SQL} for a read under other aliases. */
function provisionalCountSql(alias: string, splitAlias: string): string {
  return `COUNT(DISTINCT ${alias}.id) FILTER (WHERE ${splitAlias}.id IS NULL AND ${alias}.amountIsProvisional = true)`;
}

/** Each key's provisional legs, summed over its parts' `provisionalCount`. */
function provisionalCountsBy(
  rows: readonly RawGroupRow[],
  keyOf: (row: RawGroupRow) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(
      key,
      (counts.get(key) ?? 0) + (Number(row.provisionalCount) || 0),
    );
  }
  return counts;
}

/** A grouped raw row: its label columns, its currency and its day. */
type RawGroupRow = Record<string, any>;

/**
 * {@link splitByRateBasis}'s columns for the `transaction` alias, for a read
 * that keeps no transfer legs.
 */
const TRANSACTION_OWN_RATE_BASIS: RateBasisColumns = {
  currency: "transaction.currencyCode",
  date: "transaction.transactionDate",
  originalCurrency: "transaction.originalCurrencyCode",
  exchangeRate: "transaction.exchangeRate",
};

/**
 * The same, for a read whose rows can be transfer legs: whole rows and, on
 * the joined `splits`, a split's transfer lines.
 */
const TRANSACTION_RATE_BASIS: RateBasisColumns = {
  ...TRANSACTION_OWN_RATE_BASIS,
  transferLegs: {
    transactionAlias: "transaction",
    splitAlias: "splits",
    wholeLegs: true,
  },
};

/** The transaction-list filter surface every analytics read applies. */
interface AnalyticsReadFilters {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  categoryIds?: string[];
  payeeIds?: string[];
  search?: string;
  amountFrom?: number;
  amountTo?: number;
  excludeInvestmentLinked?: boolean;
  /** Leave out whole transfer rows and a split's transfer lines alike. */
  excludeTransfers?: boolean;
  tagIds?: string[];
  includeUnreconciledBeforeStart?: boolean;
  jointAccountIds?: string[];
}

/** One (key, currency) row of a grouped analytics read. */
export interface GroupedTotalRow {
  id: string | null;
  name: string | null;
  /**
   * The group's category type when grouped by category (null for the
   * uncategorized group and when grouped by payee): a `transfer` group holds
   * transfer legs, a named flow, never spending or income.
   */
  categoryType: CategoryType | null;
  currencyCode: string;
  total: number;
  count: number;
  /** The provisional transfer amounts inside `total` (and `convertedTotal`). */
  provisionalCount: number;
  /** The reader's reporting currency, which `convertedTotal` is in. */
  convertedCurrency: string;
  /** `total` at each row's own rate or on its own date; null without one. */
  convertedTotal: number | null;
}

/**
 * A transaction summary in the reader's reporting currency, each row converted
 * at its own rate or on its own date. `totalIncome`, `totalExpenses` and
 * `netCashFlow` are null while any bucket has no rate; the `known*` figures
 * carry what converted, and the transaction counts split on the same line.
 * `knownNet` is the known income less the known expenses, rounded once and
 * present whether or not the summary is complete (where it equals
 * `netCashFlow`), so a partial net is never the difference of two rounded
 * sides (docs/specs/report-rounding-and-aggregation.md rule 2).
 */
export interface SummaryInReportingCurrency {
  currency: string;
  totalIncome: number | null;
  totalExpenses: number | null;
  netCashFlow: number | null;
  knownIncome: number;
  knownExpenses: number;
  knownNet: number;
  includedTransactionCount: number;
  excludedTransactionCount: number;
  /**
   * The provisional transfer amounts inside the `known*` figures: those of
   * the included buckets, never of a currency in `missingCurrencies`.
   */
  provisionalCount: number;
  missingCurrencies: string[];
}

interface FoldedGroup {
  first: RawGroupRow;
  agg: FxAggregate;
  count: number;
  /** The provisional legs of the parts that converted into `agg`. */
  provisionalCount: number;
}

interface ConvertedFlowTotals {
  income: FxAggregate;
  expenses: FxAggregate;
  /** The provisional legs of the parts that converted into the two totals. */
  provisionalCount: number;
  totalsCurrency: string;
  /** `totalsCurrency`'s places, the ones its figures are read at. */
  places: number;
}

/** A grouped breakdown with the conversion gaps its rows carry. */
interface LlmBreakdown {
  rows: unknown;
  fx: FxAggregate;
}

interface ComparisonItem {
  label: string;
  agg: FxAggregate;
  count: number;
  provisionalCount: number;
}

interface ComparisonPeriodData {
  totalsCurrency: string;
  items: ComparisonItem[];
  /** Everything in `items`, for the period's own total. */
  total: FxAggregate;
  /** The provisional legs inside `total`. */
  provisionalCount: number;
}

/**
 * Add one dated amount of `row.currencyCode` to `agg` in the reporting
 * currency. Zero needs no rate and the same currency needs none; anything else
 * is converted at its own settled rate or the rate for its date, or recorded
 * as a gap. A query feeding it adds {@link byOwnRate}. Answers whether the
 * amount is in the aggregate's known figure, `false` only for a gap.
 */
function addDatedAmount(
  agg: FxAggregate,
  amount: number,
  row: RawGroupRow,
  reporting: string,
  rates: RateIndex,
  logger: Logger,
): boolean {
  if (amount === 0) return true;
  if (row.currencyCode === reporting) {
    agg.addConverted(amount);
    return true;
  }
  // The row's own settled rate where it reaches the reporting currency
  // (INV-FX-002), else the market rate on its date: the reports' rule.
  const basis = partRateBasis(row, row.currencyCode, row.txDate, reporting);
  const converted = convertRateBasis(amount, basis, reporting, rates, logger);
  agg.add(converted, row.currencyCode, reporting);
  return converted !== null;
}

/** At most this many groups, 100 unless the caller asks; never past 500. */
const clampGroupLimit = (limit: number | undefined): number =>
  Math.min(Math.max(limit ?? 100, 1), 500);

/**
 * Select and group by the columns a part outside `reporting` needs to convert
 * at the rate it settled at, for a read that already splits every row by its
 * day, so {@link addDatedAmount} reads each part's own rate the way the
 * reports do (INV-FX-002); `alias` is the query's transaction alias. A read
 * whose rows can be transfer legs passes `transfers`, so a leg converts at its
 * transfer's posted amounts too, and `splitAlias` when they are LEFT JOINed to
 * their split lines, so a split's transfer line converts at its own.
 */
function byOwnRate(
  qb: SelectQueryBuilder<Transaction>,
  alias: string,
  reporting: string,
  {
    transfers = false,
    splitAlias,
  }: { transfers?: boolean; splitAlias?: string } = {},
): SelectQueryBuilder<Transaction> {
  const transferLegs = splitAlias
    ? { transactionAlias: alias, splitAlias, wholeLegs: true }
    : { transactionAlias: alias };
  splitByRateBasis(
    qb,
    {
      currency: `${alias}.currencyCode`,
      originalCurrency: `${alias}.originalCurrencyCode`,
      exchangeRate: `${alias}.exchangeRate`,
      ...(transfers ? { transferLegs } : {}),
    },
    reporting,
    { byDay: false },
  );
  return qb;
}

/**
 * A group's figure: `total` only when every part converted, otherwise `null`
 * with the converted part under `knownSubtotal`.
 */
function totalFields(
  agg: FxAggregate,
  places: number,
): {
  total: number | null;
  knownSubtotal?: number;
} {
  // A converted, reporting-currency figure, read once at `places`.
  return agg.isComplete
    ? { total: agg.knownSubtotalAt(places) }
    : { total: null, knownSubtotal: agg.knownSubtotalAt(places) };
}

/** Largest first, by what converted (a withheld total still ranks). */
function byKnownSubtotal<
  T extends { total: number | null; knownSubtotal?: number },
>(rows: T[]): T[] {
  const figure = (r: T) => r.knownSubtotal ?? r.total ?? 0;
  return rows.sort((a, b) => figure(b) - figure(a));
}

/**
 * LLM06-F2: Fold payee groups with fewer than MIN_AGGREGATION_COUNT
 * transactions into a single "Other (aggregated)" bucket so individual
 * transaction amounts can't leak via targeted queries.
 */
interface PayeeGroup {
  payee: string;
  payeeId: string | null;
  agg: FxAggregate;
  count: number;
}

function enforcePayeeAggregationThreshold(rows: PayeeGroup[], places: number) {
  const above = rows.filter((r) => r.count >= MIN_AGGREGATION_COUNT);
  const below = rows.filter((r) => r.count < MIN_AGGREGATION_COUNT);

  if (below.length > 0) {
    const other = new FxAggregate();
    for (const r of below) other.merge(r.agg);
    // The synthetic bucket must never carry a real payee id -- it exists to
    // hide the identities of the folded groups.
    above.push({
      payee: "Other (aggregated)",
      payeeId: null,
      agg: other,
      count: below.reduce((sum, r) => sum + r.count, 0),
    });
  }

  return byKnownSubtotal(
    above.map((r) => ({
      payee: r.payee,
      payeeId: r.payeeId,
      ...totalFields(r.agg, places),
      count: r.count,
    })),
  );
}
