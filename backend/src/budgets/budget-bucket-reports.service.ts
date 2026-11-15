import { Injectable } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { loadCurrencyPlacesForRead } from "../common/currency-places.util";
import { moneyDecimalsFor, sumMoney } from "../common/round.util";
import { BudgetsService } from "./budgets.service";
import { getCurrentMonthPeriodDates } from "./budget-date.utils";
import {
  BudgetBucketFigure,
  BudgetBucketFigures,
  computeBudgetBucketFigures,
} from "./budget-bucket-figures.util";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodBucket } from "./entities/budget-period-bucket.entity";

/** A bucket as the live read exposes it: the figures minus `carryOut`. */
export type BudgetBucketStatusBucket = Omit<BudgetBucketFigure, "carryOut">;

/** `GET /budgets/:id/reports/bucket-status` (design section 6.5). */
export interface BudgetBucketStatusResult extends Omit<
  BudgetBucketFigures,
  "buckets"
> {
  periodStart: string;
  periodEnd: string;
  currencyCode: string;
  buckets: BudgetBucketStatusBucket[];
}

@Injectable()
export class BudgetBucketReportsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly budgetsService: BudgetsService,
  ) {}

  async getBucketStatus(
    userId: string,
    budgetId: string,
  ): Promise<BudgetBucketStatusResult> {
    // The line figures, actual income and ownership check are the summary's;
    // this service runs no actuals query of its own.
    const summary = await this.budgetsService.getSummary(userId, budgetId);
    const budget = summary.budget;
    // The summary reads the current calendar month (`getCurrentPeriodDates` in
    // BudgetsService is `getCurrentMonthPeriodDates`); the same function names
    // the dates here.
    const { periodStart, periodEnd } = getCurrentMonthPeriodDates();

    const bucketIdByLine = new Map<string, string | null>();
    for (const bc of budget.categories ?? []) {
      bucketIdByLine.set(bc.id, bc.bucketId ?? null);
    }
    const lines = summary.categoryBreakdown.map((row) => ({
      bucketId: bucketIdByLine.get(row.budgetCategoryId) ?? null,
      isIncome: row.isIncome,
      budgeted: row.budgeted,
      spent: row.spent,
    }));

    const { decimals, carriedIn } = await withScopedDb(
      this.dataSource,
      async (m) => {
        const places = await loadCurrencyPlacesForRead(m, [
          budget.currencyCode,
        ]);
        const decimalPlaces = places.get(budget.currencyCode.toUpperCase());
        const period = await m.getRepository(BudgetPeriod).findOne({
          where: { budgetId, status: PeriodStatus.OPEN },
        });
        const bucketIds = (budget.buckets ?? []).map((b) => b.id);
        const rows =
          period && bucketIds.length > 0
            ? await m.getRepository(BudgetPeriodBucket).find({
                where: {
                  budgetPeriodId: period.id,
                  bucketId: In(bucketIds),
                },
              })
            : [];
        const map = new Map<string, number>();
        for (const row of rows) {
          if (row.bucketId !== null) map.set(row.bucketId, row.carryIn);
        }
        return { decimals: moneyDecimalsFor(decimalPlaces), carriedIn: map };
      },
    );

    const figures = computeBudgetBucketFigures({
      buckets: budget.buckets ?? [],
      lines,
      incomeLinked: summary.incomeLinked,
      baseIncome: budget.baseIncome ?? null,
      incomeLinesBudgeted: sumMoney(
        lines.filter((l) => l.isIncome).map((l) => l.budgeted),
        decimals,
      ),
      actualIncome: summary.actualIncome,
      carriedIn,
      decimals,
    });

    return {
      periodStart,
      periodEnd,
      currencyCode: budget.currencyCode,
      income: figures.income,
      incomeSource: figures.incomeSource,
      totalAllocated: figures.totalAllocated,
      knownAllocated: figures.knownAllocated,
      unallocated: figures.unallocated,
      // carryOut is the period close's (B4); the live read does not expose it.
      buckets: figures.buckets.map(({ carryOut: _carryOut, ...rest }) => rest),
      unassigned: figures.unassigned,
    };
  }
}
