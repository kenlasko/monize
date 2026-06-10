import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ReportCurrencyService } from "./report-currency.service";
import { roundMoney, toMoneyNumber } from "../common/round.util";
import {
  MonthlyCategoryBreakdownResponse,
  MonthlyBreakdownCategoryRow,
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
        COALESCE(ts.category_id, t.category_id) as category_id,
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
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
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
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'),
               COALESCE(ts.category_id, t.category_id), t.currency_code
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

      // Treat an unknown category_id (e.g. the row references a category that
      // no longer exists) the same as no category at all.
      const categoryId =
        row.category_id && categoryMap.has(row.category_id)
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

    const months = Array.from(monthSet).sort();

    const data: MonthlyBreakdownCategoryRow[] = Array.from(
      accumulators.values(),
    ).map((acc) => this.buildRow(acc, categoryMap));

    return { months, data, currency: defaultCurrency };
  }

  /**
   * Convert one accumulator into a response row. A category is income when its
   * deposits exceed its withdrawals; the per-month value is the signed net in
   * the category's dominant direction (positive magnitude either way) so the
   * frontend can render and sum it without re-deciding the sign.
   */
  private buildRow(
    acc: CategoryAccumulator,
    categoryMap: Map<string, Category>,
  ): MonthlyBreakdownCategoryRow {
    const category = acc.categoryId
      ? (categoryMap.get(acc.categoryId) ?? null)
      : null;
    const parent = category?.parentId
      ? (categoryMap.get(category.parentId) ?? null)
      : null;

    const isIncome = acc.depositTotal > acc.withdrawalTotal;

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
      categoryName: category?.name ?? "Uncategorized",
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      isIncome,
      valuesByMonth,
      depositTotal: roundMoney(acc.depositTotal),
      withdrawalTotal: roundMoney(acc.withdrawalTotal),
    };
  }
}
