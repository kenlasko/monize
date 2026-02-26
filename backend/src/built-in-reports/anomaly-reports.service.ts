import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ReportCurrencyService } from "./report-currency.service";
import {
  SpendingAnomaliesResponse,
  SpendingAnomaly,
  AnomalySeverity,
} from "./dto";
import { formatDateYMD } from "../common/date-utils";

@Injectable()
export class AnomalyReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private currencyService: ReportCurrencyService,
  ) {}

  async getSpendingAnomalies(
    userId: string,
    threshold: number = 2,
  ): Promise<SpendingAnomaliesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const startDate = formatDateYMD(sixMonthsAgo);
    const endDate = formatDateYMD(now);

    const query = `
      SELECT
        t.id,
        t.transaction_date,
        t.payee_id,
        t.payee_name,
        t.currency_code,
        COALESCE(ts.category_id, t.category_id) as category_id,
        ABS(COALESCE(ts.amount, t.amount)) as amount
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND COALESCE(ts.amount, t.amount) < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      ORDER BY t.transaction_date
    `;

    interface RawExpense {
      id: string;
      transaction_date: Date;
      payee_id: string | null;
      payee_name: string | null;
      currency_code: string;
      category_id: string | null;
      amount: string;
    }

    const rawResults: RawExpense[] = await this.transactionsRepository.query(
      query,
      [userId, startDate, endDate],
    );

    if (rawResults.length < 10) {
      return {
        statistics: { mean: 0, stdDev: 0 },
        anomalies: [],
        counts: { high: 0, medium: 0, low: 0 },
      };
    }

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const amounts = rawResults.map((r) =>
      this.currencyService.convertAmount(
        parseFloat(r.amount) || 0,
        r.currency_code,
        defaultCurrency,
        rateMap,
      ),
    );
    const mean = amounts.reduce((sum, a) => sum + a, 0) / amounts.length;
    const variance =
      amounts.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) /
      amounts.length;
    const stdDev = Math.sqrt(variance);

    const anomalies: SpendingAnomaly[] = [];

    // 1. Large single transactions
    rawResults.forEach((row) => {
      const amount = this.currencyService.convertAmount(
        parseFloat(row.amount) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const zScore = (amount - mean) / stdDev;

      if (zScore > threshold) {
        const severity: AnomalySeverity =
          zScore > threshold * 2
            ? "high"
            : zScore > threshold * 1.5
              ? "medium"
              : "low";
        const txDate = new Date(row.transaction_date);
        anomalies.push({
          type: "large_transaction",
          severity,
          title: "Unusually large transaction",
          description: `${row.payee_name || "Unknown payee"} - ${txDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
          amount: Math.round(amount * 100) / 100,
          transactionId: row.id,
          transactionDate: row.transaction_date.toString().split("T")[0],
          payeeName: row.payee_name || undefined,
        });
      }
    });

    // 2. Category spending spikes (current month vs previous month)
    this.detectCategorySpikes(
      rawResults,
      now,
      defaultCurrency,
      rateMap,
      categoryMap,
      anomalies,
    );

    // 3. New payees with significant spending
    this.detectNewPayees(rawResults, now, defaultCurrency, rateMap, anomalies);

    // Sort by severity and amount
    const severityOrder: Record<AnomalySeverity, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    anomalies.sort((a, b) => {
      const severityDiff =
        severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return (b.amount || 0) - (a.amount || 0);
    });

    return {
      statistics: {
        mean: Math.round(mean * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
      },
      anomalies,
      counts: {
        high: anomalies.filter((a) => a.severity === "high").length,
        medium: anomalies.filter((a) => a.severity === "medium").length,
        low: anomalies.filter((a) => a.severity === "low").length,
      },
    };
  }

  private detectCategorySpikes(
    rawResults: {
      transaction_date: Date;
      currency_code: string;
      category_id: string | null;
      amount: string;
    }[],
    now: Date,
    defaultCurrency: string,
    rateMap: Map<string, number>,
    categoryMap: Map<string, Category>,
    anomalies: SpendingAnomaly[],
  ): void {
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const currentMonthByCategory = new Map<string, number>();
    const previousMonthByCategory = new Map<string, number>();

    rawResults.forEach((row) => {
      const txDate = new Date(row.transaction_date);
      const amount = this.currencyService.convertAmount(
        parseFloat(row.amount) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id || "uncategorized";

      if (txDate >= currentMonthStart) {
        currentMonthByCategory.set(
          categoryId,
          (currentMonthByCategory.get(categoryId) || 0) + amount,
        );
      } else if (txDate >= prevMonthStart && txDate <= prevMonthEnd) {
        previousMonthByCategory.set(
          categoryId,
          (previousMonthByCategory.get(categoryId) || 0) + amount,
        );
      }
    });

    currentMonthByCategory.forEach((currentAmount, categoryId) => {
      const previousAmount = previousMonthByCategory.get(categoryId) || 0;
      if (previousAmount < 50) return;

      const percentChange =
        ((currentAmount - previousAmount) / previousAmount) * 100;

      if (percentChange > 100) {
        const category =
          categoryId === "uncategorized" ? null : categoryMap.get(categoryId);
        const severity: AnomalySeverity =
          percentChange > 300 ? "high" : percentChange > 200 ? "medium" : "low";
        anomalies.push({
          type: "category_spike",
          severity,
          title: `Spending spike in ${category?.name || "Uncategorized"}`,
          description: `${Math.round(percentChange)}% increase from last month`,
          categoryId: categoryId === "uncategorized" ? undefined : categoryId,
          categoryName: category?.name || "Uncategorized",
          currentPeriodAmount: Math.round(currentAmount * 100) / 100,
          previousPeriodAmount: Math.round(previousAmount * 100) / 100,
          percentChange: Math.round(percentChange),
        });
      }
    });
  }

  private detectNewPayees(
    rawResults: {
      id: string;
      transaction_date: Date;
      payee_name: string | null;
      currency_code: string;
      amount: string;
    }[],
    now: Date,
    defaultCurrency: string,
    rateMap: Map<string, number>,
    anomalies: SpendingAnomaly[],
  ): void {
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const payeeFirstSeen = new Map<string, Date>();
    const payeeRecentSpending = new Map<
      string,
      { name: string; total: number; count: number; txId: string }
    >();

    rawResults.forEach((row) => {
      const payeeName = (row.payee_name || "").toLowerCase().trim();
      if (!payeeName) return;

      const txDate = new Date(row.transaction_date);

      if (
        !payeeFirstSeen.has(payeeName) ||
        txDate < payeeFirstSeen.get(payeeName)!
      ) {
        payeeFirstSeen.set(payeeName, txDate);
      }

      if (txDate >= oneMonthAgo) {
        const existing = payeeRecentSpending.get(payeeName);
        if (existing) {
          existing.total += this.currencyService.convertAmount(
            parseFloat(row.amount) || 0,
            row.currency_code,
            defaultCurrency,
            rateMap,
          );
          existing.count++;
        } else {
          payeeRecentSpending.set(payeeName, {
            name: row.payee_name || "Unknown",
            total: this.currencyService.convertAmount(
              parseFloat(row.amount) || 0,
              row.currency_code,
              defaultCurrency,
              rateMap,
            ),
            count: 1,
            txId: row.id,
          });
        }
      }
    });

    payeeFirstSeen.forEach((firstSeen, payeeName) => {
      if (firstSeen >= oneMonthAgo) {
        const recent = payeeRecentSpending.get(payeeName);
        if (recent && recent.total > 100) {
          const severity: AnomalySeverity =
            recent.total > 500 ? "high" : recent.total > 200 ? "medium" : "low";
          anomalies.push({
            type: "unusual_payee",
            severity,
            title: "New payee detected",
            description: `${recent.name} - ${recent.count} transaction(s)`,
            amount: Math.round(recent.total * 100) / 100,
            transactionId: recent.txId,
            payeeName: recent.name,
          });
        }
      }
    });
  }
}
