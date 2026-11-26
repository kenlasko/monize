import { Injectable } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { loadCurrencyPlacesForRead } from "../common/currency-places.util";
import { moneyDecimalsFor } from "../common/round.util";
import { BudgetsService } from "./budgets.service";
import {
  BudgetBucketFigure,
  BudgetBucketFigures,
  buildBudgetBucketFiguresInput,
  computeBudgetBucketFigures,
} from "./budget-bucket-figures.util";
import { BudgetPeriod } from "./entities/budget-period.entity";
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
    // The dates the summary read its figures for, not a second clock read: a
    // request straddling midnight at a month boundary would otherwise label
    // one month's figures with the next month's dates.
    const { periodStart, periodEnd } = summary;

    const { decimals, carriedIn } = await withScopedDb(
      this.dataSource,
      async (m) => {
        const places = await loadCurrencyPlacesForRead(m, [
          budget.currencyCode,
        ]);
        const decimalPlaces = places.get(budget.currencyCode.toUpperCase());
        const period = await m.getRepository(BudgetPeriod).findOne({
          where: { budgetId, periodStart },
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

    const figures = computeBudgetBucketFigures(
      buildBudgetBucketFiguresInput({
        budget,
        rows: summary.categoryBreakdown,
        actualIncome: summary.actualIncome,
        carriedIn,
        decimals,
      }),
    );

    return {
      periodStart,
      periodEnd,
      currencyCode: budget.currencyCode,
      income: figures.income,
      incomeSource: figures.incomeSource,
      totalAllocated: figures.totalAllocated,
      knownAllocated: figures.knownAllocated,
      unallocated: figures.unallocated,
      // carryOut is the period close's; the live read does not expose it.
      buckets: figures.buckets.map(({ carryOut: _carryOut, ...rest }) => rest),
      unassigned: figures.unassigned,
    };
  }
}
