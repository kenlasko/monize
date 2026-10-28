import { ReportingRead } from "../accruals/reporting-basis";
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import { investmentExclusionSql } from "../common/investment-filter.util";
import {
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { tr } from "../i18n/translate";
import { ReportCurrencyService } from "./report-currency.service";
import {
  assembleCashFlowSankey,
  SankeyCategorizedRow,
  SankeyIdentityError,
  SankeyTransferRow,
} from "./cash-flow-sankey-assembly";
import { CashFlowSankeyResponse, SankeyDepth } from "./dto";

/**
 * Investment scope is LINKAGE, never account type (INV-REPORT-001): a BUY's or
 * DIVIDEND's cash leg is not a flow on any branch, transfers included
 * (decision 6, SANKEY-003). `common/investment-filter.util.ts` owns why.
 */
const INVESTMENT_EXCLUSION = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
  splitAlias: "ts",
});

/** The no-splits variant, for the whole-transfer query. */
const INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
});

/**
 * The account types the default scope is made of (decision 1, K1: SAVINGS is
 * in). An INVESTMENT account is never in the default, so neither sleeve of a
 * pair is.
 */
export const DEFAULT_SANKEY_SCOPE_TYPES = [
  "CHEQUING",
  "SAVINGS",
  "CASH",
  "CREDIT_CARD",
  "LINE_OF_CREDIT",
] as const;

/**
 * The row's own rate into the reporting currency, when it carries one that
 * reaches it (INV-FX-002): a foreign entry whose original currency IS the
 * reporting currency settled at `exchange_rate` account-currency units per
 * reporting unit. A stored 1 between two different codes is the column's
 * default, not a rate, and falls back to the market rate like an absent one.
 */
const OWN_RATE_SQL = (currencyParam: string) => `CASE
          WHEN t.original_currency_code = ${currencyParam}
           AND t.original_currency_code <> t.currency_code
           AND t.exchange_rate > 0
           AND t.exchange_rate <> 1
          THEN t.exchange_rate
        END`;

/** What every query builder is handed. */
interface SankeyQueryScope {
  userId: string;
  scopeAccountIds: string[];
  startDate: string | undefined;
  endDate: string;
  currency: string;
}

interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/** `$1..$4` are shared; the start date, when present, is `$5`. */
function baseParams(scope: SankeyQueryScope): {
  params: unknown[];
  startClause: string;
} {
  const params: unknown[] = [
    scope.userId,
    scope.scopeAccountIds,
    scope.endDate,
    scope.currency,
  ];
  if (!scope.startDate) return { params, startClause: "" };
  params.push(scope.startDate);
  return { params, startClause: "AND t.transaction_date >= $5" };
}

/**
 * Income and expense rows of in-scope accounts: categorized cash, never a
 * transfer (INV-REPORT-003), never an investment cash leg, never VOID. Both
 * signs are read so a category nets (a refund reduces what was spent) while an
 * uncategorized row keeps its own side.
 */
export function categorizedRowsQuery(scope: SankeyQueryScope): BuiltQuery {
  const { params, startClause } = baseParams(scope);
  return {
    params,
    sql: `
      SELECT
        COALESCE(ts.category_id, t.category_id) AS category_id,
        t.currency_code,
        TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
        ${OWN_RATE_SQL("$4")} AS own_rate,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount) ELSE 0 END) AS positive,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0 THEN COALESCE(ts.amount, t.amount) ELSE 0 END) AS negative
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.account_id = ANY($2::uuid[])
        AND t.transaction_date <= $3
        ${startClause}
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND COALESCE(ts.amount, t.amount) <> 0
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
      GROUP BY 1, 2, 3, 4
    `,
  };
}

/**
 * Whole transfer legs (`is_transfer = true`) whose own account is in scope and
 * whose counterpart is not (SANKEY-002). The counterpart is the linked row's
 * account. A leg whose linked row this reader cannot see -- deleted, never
 * linked (an import), or the other owner's leg of a cross-owner transfer --
 * has none, and is "other accounts" under "(unlinked account)" so the
 * identity still closes. Both legs
 * of an internal transfer fail the counterpart predicate, so neither is read.
 */
export function wholeTransferLegsQuery(scope: SankeyQueryScope): BuiltQuery {
  const { params, startClause } = baseParams(scope);
  return {
    params,
    sql: `
      SELECT
        cp.id AS counterpart_account_id,
        cp.account_type::text AS counterpart_type,
        cp.name AS counterpart_name,
        t.currency_code,
        TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
        ${OWN_RATE_SQL("$4")} AS own_rate,
        SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS inflow,
        SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) AS outflow
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN transactions lt ON lt.id = t.linked_transaction_id
      LEFT JOIN accounts cp ON cp.id = lt.account_id
      WHERE t.user_id = $1
        AND t.account_id = ANY($2::uuid[])
        AND t.transaction_date <= $3
        ${startClause}
        AND t.is_transfer = true
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        AND t.amount <> 0
        AND (cp.id IS NULL OR NOT (cp.id = ANY($2::uuid[])))
      GROUP BY 1, 2, 3, 4, 5, 6
    `,
  };
}

/**
 * Transfer lines of a split (`transfer_account_id` set) on an in-scope
 * account, to an out-of-scope counterpart (SANKEY-002): a mortgage payment's
 * principal line is the debt flow, its interest line stays a category above.
 * The leg's amount is its own signed amount.
 */
export function splitTransferLegsQuery(scope: SankeyQueryScope): BuiltQuery {
  const { params, startClause } = baseParams(scope);
  return {
    params,
    sql: `
      SELECT
        cp.id AS counterpart_account_id,
        cp.account_type::text AS counterpart_type,
        cp.name AS counterpart_name,
        t.currency_code,
        TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
        ${OWN_RATE_SQL("$4")} AS own_rate,
        SUM(CASE WHEN ts.amount > 0 THEN ts.amount ELSE 0 END) AS inflow,
        SUM(CASE WHEN ts.amount < 0 THEN ts.amount ELSE 0 END) AS outflow
      FROM transactions t
      JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts cp ON cp.id = ts.transfer_account_id
      WHERE t.user_id = $1
        AND t.account_id = ANY($2::uuid[])
        AND t.transaction_date <= $3
        ${startClause}
        AND ts.transfer_account_id IS NOT NULL
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND ts.amount <> 0
        AND NOT (ts.transfer_account_id = ANY($2::uuid[]))
      GROUP BY 1, 2, 3, 4, 5, 6
    `,
  };
}

interface RawCategorizedRow {
  category_id: string | null;
  currency_code: string;
  tx_date: string;
  own_rate: string | null;
  positive: string;
  negative: string;
}

interface RawTransferRow {
  counterpart_account_id: string | null;
  counterpart_type: string | null;
  counterpart_name: string | null;
  currency_code: string;
  tx_date: string;
  own_rate: string | null;
  inflow: string;
  outflow: string;
}

const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toRate = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The Cash Flow Sankey (`docs/specs/sankey-cash-flow.md`): where money
 * came from and where it went over a window, for a scope of cash-flow
 * accounts. Every figure is this service's; the client merges small nodes for
 * drawing only (SANKEY-005).
 */
@Injectable()
export class CashFlowSankeyService {
  private readonly logger = new Logger(CashFlowSankeyService.name);

  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  @ReportingRead("cash")
  async getCashFlowSankey(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options: { accountIds?: string[]; depth?: SankeyDepth } = {},
  ): Promise<CashFlowSankeyResponse> {
    const depth: SankeyDepth = options.depth === 2 ? 2 : 1;
    const currency = await this.currencyService.getDefaultCurrency(userId);
    const scopeAccountIds = await this.resolveScope(userId, options.accountIds);

    const scope: SankeyQueryScope = {
      userId,
      scopeAccountIds,
      startDate,
      endDate,
      currency,
    };

    const [rawCategorized, rawWhole, rawSplit, categories] =
      scopeAccountIds.length === 0
        ? [[], [], [], []]
        : await withScopedDb(this.dataSource, async (m) => {
            const categorized = categorizedRowsQuery(scope);
            const whole = wholeTransferLegsQuery(scope);
            const split = splitTransferLegsQuery(scope);
            return [
              (await m.query(
                categorized.sql,
                categorized.params,
              )) as RawCategorizedRow[],
              (await m.query(whole.sql, whole.params)) as RawTransferRow[],
              (await m.query(split.sql, split.params)) as RawTransferRow[],
              await m.getRepository(Category).find({ where: { userId } }),
            ] as const;
          });

    const categorized: SankeyCategorizedRow[] = rawCategorized.map((row) => ({
      categoryId: row.category_id,
      currency: row.currency_code,
      date: row.tx_date,
      ownRate: toRate(row.own_rate),
      positive: toNumber(row.positive),
      negative: toNumber(row.negative),
    }));
    const transfers: SankeyTransferRow[] = [...rawWhole, ...rawSplit].map(
      (row) => ({
        counterpartAccountId: row.counterpart_account_id,
        counterpartType: row.counterpart_type,
        counterpartName: row.counterpart_name,
        currency: row.currency_code,
        date: row.tx_date,
        ownRate: toRate(row.own_rate),
        inflow: toNumber(row.inflow),
        outflow: toNumber(row.outflow),
      }),
    );

    // Without a start date the window opens on the earliest row it holds.
    const effectiveStart =
      startDate ??
      [...categorized, ...transfers].reduce(
        (earliest, row) => (row.date < earliest ? row.date : earliest),
        endDate,
      );

    // Only rows the market rate has to convert need the history: a row in the
    // reporting currency needs none, and one carrying its own rate uses it.
    const foreign = new Set(
      [...categorized, ...transfers]
        .filter((row) => row.currency !== currency && row.ownRate === null)
        .map((row) => row.currency),
    );
    const rateIndex = await buildRateIndex(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      foreign,
      currency,
      effectiveStart,
      endDate,
    );

    try {
      return assembleCashFlowSankey({
        startDate: effectiveStart,
        endDate,
        currency,
        scopeAccountIds,
        depth,
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          parentId: c.parentId,
          color: c.color,
          isIncome: c.isIncome,
        })),
        categorized,
        transfers,
        convert: (amount, from, date, ownRate) => {
          if (from === currency) return amount;
          // INV-FX-002: the row's own rate, where it reaches the reporting
          // currency, before the market's.
          if (ownRate !== null) return amount / ownRate;
          // INV-FX-001: the newest observation on or before the row's date,
          // within the age bound, or unknown.
          return convertAtDate(
            amount,
            from,
            currency,
            date,
            rateIndex,
            this.logger,
          );
        },
      });
    } catch (error) {
      if (error instanceof SankeyIdentityError) {
        // SANKEY-001: a diagram that does not close is never drawn.
        this.logger.error(
          `${error.message}; discrepancy ${error.discrepancyMinor}`,
        );
        throw new InternalServerErrorException(
          tr("errors.http.internal", "Internal server error"),
        );
      }
      throw error;
    }
  }

  /**
   * The request's accounts the caller can see, or the default cash-flow scope
   * (decision 1): every open account of the default types. Sorted, so the
   * echoed scope is stable.
   */
  private async resolveScope(
    userId: string,
    accountIds: string[] | undefined,
  ): Promise<string[]> {
    const rows: Array<{ id: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        accountIds && accountIds.length > 0
          ? m.query(
              `SELECT id FROM accounts
                WHERE user_id = $1
                  AND id = ANY($2::uuid[])
                ORDER BY id`,
              [userId, accountIds],
            )
          : m.query(
              `SELECT id FROM accounts
                WHERE user_id = $1
                  AND (is_closed IS NULL OR is_closed = false)
                  AND account_sub_type IS NULL
                  AND account_type::text = ANY($2::text[])
                ORDER BY id`,
              [userId, [...DEFAULT_SANKEY_SCOPE_TYPES]],
            ),
    );
    return rows.map((row) => row.id);
  }
}
