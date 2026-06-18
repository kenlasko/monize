import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ReportCurrencyService } from "./report-currency.service";
import { roundMoney, toMoneyNumber } from "../common/round.util";
import { INVESTMENT_INCOME_PSEUDO_CATEGORY } from "../common/query-param-utils";
import {
  MonthlyCategoryBreakdownResponse,
  MonthlyBreakdownCategoryRow,
  MonthlyBreakdownTransferRow,
} from "./dto";

/**
 * Raw per-(category, month, currency) aggregate. Deposits and withdrawals are
 * summed separately so the frontend can classify a category as income vs
 * expense and render a signed net value per month.
 */
interface RawBreakdownAggregate {
  month: string;
  category_id: string | null;
  currency_code: string;
  deposits: string;
  withdrawals: string;
}

/**
 * Raw per-(account, month, currency) transfer aggregate. Outflows and inflows
 * are summed separately so each account can be split into a "from" row
 * (outflows, a source of funds) and a "to" row (inflows, a use of funds).
 */
interface RawTransferAggregate {
  month: string;
  account_id: string;
  account_name: string;
  currency_code: string;
  outflow: string;
  inflow: string;
}

/**
 * Mutable accumulator for a single category while merging the raw rows. Money
 * is accumulated in floating numbers but every read-out is rounded with the
 * shared money helpers so the response never carries IEEE 754 drift.
 */
interface CategoryAccumulator {
  categoryId: string | null;
  depositByMonth: Map<string, number>;
  withdrawalByMonth: Map<string, number>;
  depositTotal: number;
  withdrawalTotal: number;
}

@Injectable()
export class MonthlyCategoryBreakdownService {
  /**
   * SQL predicate (correlated on the `transactions t` alias) that matches the
   * cash leg of a brokerage income event -- interest, dividends or capital
   * gains paid into a linked cash account. The investment importer records both
   * sides of such an event as `is_transfer = true` (a cash leg plus a synthetic
   * brokerage-side offset), even though, unlike a buy or sell, this is new money
   * entering the books rather than a movement between the user's own accounts.
   * Either leg is recognised here -- the cash leg via its `linked_transaction_id`
   * pointing at the brokerage leg, the brokerage leg via its own id -- so the
   * breakdown can surface the cash leg as income and drop both legs from the
   * transfers section. Buys and sells are genuine cash<->holdings transfers and
   * are deliberately excluded.
   */
  private static readonly INVESTMENT_INCOME_LEG_PREDICATE = `
    EXISTS (
      SELECT 1 FROM investment_transactions it
      WHERE it.action IN ('INTEREST', 'DIVIDEND', 'CAPITAL_GAIN')
        AND (it.transaction_id = t.id
             OR it.transaction_id = t.linked_transaction_id)
    )`;

  /**
   * Category id expression for the income aggregate: a recognised brokerage
   * income leg collapses to the synthetic INVESTMENT_INCOME_PSEUDO_CATEGORY
   * bucket (it carries no real category), otherwise the row keeps its own
   * category (split category first, then the transaction's). Used identically in
   * the SELECT list and GROUP BY so the grouping key matches the projection.
   */
  private static readonly INVESTMENT_INCOME_CATEGORY_EXPR = `
    COALESCE(
      (SELECT '${INVESTMENT_INCOME_PSEUDO_CATEGORY}'
         FROM investment_transactions it
        WHERE it.action IN ('INTEREST', 'DIVIDEND', 'CAPITAL_GAIN')
          AND (it.transaction_id = t.id
               OR it.transaction_id = t.linked_transaction_id)
        LIMIT 1),
      ts.category_id::text, t.category_id::text
    )`;

  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private currencyService: ReportCurrencyService,
  ) {}

  async getMonthlyCategoryBreakdown(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<MonthlyCategoryBreakdownResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    // Aggregate deposits (amount > 0) and withdrawals (amount < 0) per
    // category, month and currency. Transfers, voided rows, child rows of a
    // split, investment accounts and the synthetic asset-value-change category
    // are excluded -- mirroring the other category reports.
    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        ${MonthlyCategoryBreakdownService.INVESTMENT_INCOME_CATEGORY_EXPR} as category_id,
        t.currency_code,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0
              THEN COALESCE(ts.amount, t.amount) ELSE 0 END) as deposits,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0
              THEN ABS(COALESCE(ts.amount, t.amount)) ELSE 0 END) as withdrawals
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND (t.is_transfer = false
             OR ${MonthlyCategoryBreakdownService.INVESTMENT_INCOME_LEG_PREDICATE})
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND (a.account_type != 'INVESTMENT'
             OR (a.account_sub_type = 'INVESTMENT_CASH'
                 AND ${MonthlyCategoryBreakdownService.INVESTMENT_INCOME_LEG_PREDICATE}))
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += `
      GROUP BY 1, 2, t.currency_code
      ORDER BY month
    `;

    const rawResults: RawBreakdownAggregate[] =
      await this.transactionsRepository.query(query, params);

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const accumulators = new Map<string, CategoryAccumulator>();
    const monthSet = new Set<string>();

    for (const row of rawResults) {
      const month = row.month;
      monthSet.add(month);

      const deposits = this.currencyService.convertAmount(
        toMoneyNumber(row.deposits),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const withdrawals = this.currencyService.convertAmount(
        toMoneyNumber(row.withdrawals),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );

      // Keep the synthetic investment-income bucket as its own row; otherwise
      // treat an unknown category_id (e.g. the row references a category that
      // no longer exists) the same as no category at all.
      const categoryId =
        row.category_id === INVESTMENT_INCOME_PSEUDO_CATEGORY
          ? INVESTMENT_INCOME_PSEUDO_CATEGORY
          : row.category_id && categoryMap.has(row.category_id)
            ? row.category_id
            : null;
      const key = categoryId ?? "uncategorized";

      let acc = accumulators.get(key);
      if (!acc) {
        acc = {
          categoryId,
          depositByMonth: new Map(),
          withdrawalByMonth: new Map(),
          depositTotal: 0,
          withdrawalTotal: 0,
        };
        accumulators.set(key, acc);
      }

      acc.depositByMonth.set(
        month,
        (acc.depositByMonth.get(month) ?? 0) + deposits,
      );
      acc.withdrawalByMonth.set(
        month,
        (acc.withdrawalByMonth.get(month) ?? 0) + withdrawals,
      );
      acc.depositTotal += deposits;
      acc.withdrawalTotal += withdrawals;
    }

    const transfers = await this.getTransferRows(
      userId,
      startDate,
      endDate,
      defaultCurrency,
      rateMap,
      monthSet,
    );

    const months = Array.from(monthSet).sort();

    const data: MonthlyBreakdownCategoryRow[] = Array.from(
      accumulators.values(),
    ).map((acc) => this.buildRow(acc, categoryMap));

    return { months, data, transfers, currency: defaultCurrency };
  }

  /**
   * Aggregate transfers per (account, month) into signed "from"/"to" rows.
   * Each transfer is stored as two linked legs (a negative leg on the source
   * account and a positive leg on the destination account); grouping every
   * leg by the account it sits on therefore counts each transfer exactly once
   * per side. Outflows become a "from" row (positive, a source of funds) and
   * inflows become a "to" row (negative, a use of funds). Months that contain
   * transfers but no categorised activity are added to the shared month set.
   */
  private async getTransferRows(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    defaultCurrency: string,
    rateMap: Map<string, number>,
    monthSet: Set<string>,
  ): Promise<MonthlyBreakdownTransferRow[]> {
    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        t.account_id,
        a.name as account_name,
        t.currency_code,
        SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as outflow,
        SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as inflow
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = true
        AND NOT ${MonthlyCategoryBreakdownService.INVESTMENT_INCOME_LEG_PREDICATE}
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'),
               t.account_id, a.name, t.currency_code
      ORDER BY month
    `;

    const rawResults: RawTransferAggregate[] =
      await this.transactionsRepository.query(query, params);

    // Accumulate the signed flow per (account, direction) across currencies.
    const fromByAccount = new Map<
      string,
      { name: string; valuesByMonth: Map<string, number> }
    >();
    const toByAccount = new Map<
      string,
      { name: string; valuesByMonth: Map<string, number> }
    >();

    const addFlow = (
      store: Map<string, { name: string; valuesByMonth: Map<string, number> }>,
      accountId: string,
      accountName: string,
      month: string,
      amount: number,
    ) => {
      let entry = store.get(accountId);
      if (!entry) {
        entry = { name: accountName, valuesByMonth: new Map() };
        store.set(accountId, entry);
      }
      entry.valuesByMonth.set(
        month,
        (entry.valuesByMonth.get(month) ?? 0) + amount,
      );
    };

    for (const row of rawResults) {
      monthSet.add(row.month);
      const outflow = this.currencyService.convertAmount(
        toMoneyNumber(row.outflow),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const inflow = this.currencyService.convertAmount(
        toMoneyNumber(row.inflow),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (outflow !== 0) {
        addFlow(
          fromByAccount,
          row.account_id,
          row.account_name,
          row.month,
          outflow,
        );
      }
      if (inflow !== 0) {
        addFlow(
          toByAccount,
          row.account_id,
          row.account_name,
          row.month,
          inflow,
        );
      }
    }

    const buildTransferRows = (
      store: Map<string, { name: string; valuesByMonth: Map<string, number> }>,
      direction: "from" | "to",
    ): MonthlyBreakdownTransferRow[] =>
      Array.from(store.entries()).map(([accountId, entry]) => {
        const valuesByMonth: Record<string, number> = {};
        for (const [month, amount] of entry.valuesByMonth) {
          // "from" rows are a source of funds (positive); "to" rows are a use
          // of funds (negative).
          valuesByMonth[month] = roundMoney(
            direction === "from" ? amount : -amount,
          );
        }
        return { accountId, accountName: entry.name, direction, valuesByMonth };
      });

    return [
      ...buildTransferRows(fromByAccount, "from"),
      ...buildTransferRows(toByAccount, "to"),
    ];
  }

  /**
   * Convert one accumulator into a response row. A category is income when its
   * own isIncome flag says so (falling back to deposits-dominate only for
   * uncategorized rows that have no category record); the per-month value is
   * the signed net in that direction (positive magnitude either way) so the
   * frontend can render and sum it without re-deciding the sign.
   */
  private buildRow(
    acc: CategoryAccumulator,
    categoryMap: Map<string, Category>,
  ): MonthlyBreakdownCategoryRow {
    const isInvestmentIncome =
      acc.categoryId === INVESTMENT_INCOME_PSEUDO_CATEGORY;
    const category =
      acc.categoryId && !isInvestmentIncome
        ? (categoryMap.get(acc.categoryId) ?? null)
        : null;
    const parent = category?.parentId
      ? (categoryMap.get(category.parentId) ?? null)
      : null;

    // Brokerage interest, dividends and capital gains are always income; a real
    // category goes by its own flag, and a bare uncategorized bucket falls back
    // to whichever side dominates.
    const isIncome = isInvestmentIncome
      ? true
      : category
        ? category.isIncome
        : acc.depositTotal > acc.withdrawalTotal;

    const valuesByMonth: Record<string, number> = {};
    const allMonths = new Set<string>([
      ...acc.depositByMonth.keys(),
      ...acc.withdrawalByMonth.keys(),
    ]);
    for (const month of allMonths) {
      const deposits = acc.depositByMonth.get(month) ?? 0;
      const withdrawals = acc.withdrawalByMonth.get(month) ?? 0;
      const net = isIncome ? deposits - withdrawals : withdrawals - deposits;
      valuesByMonth[month] = roundMoney(net);
    }

    return {
      categoryId: acc.categoryId,
      categoryName: isInvestmentIncome
        ? "Investment Income"
        : (category?.name ?? "Uncategorized"),
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      parentIsIncome: parent?.isIncome ?? null,
      isIncome,
      valuesByMonth,
      depositTotal: roundMoney(acc.depositTotal),
      withdrawalTotal: roundMoney(acc.withdrawalTotal),
    };
  }
}
