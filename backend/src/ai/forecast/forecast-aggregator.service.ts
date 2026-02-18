import { Injectable, Inject, Logger, forwardRef } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";
import { AccountsService } from "../../accounts/accounts.service";

export interface MonthlyHistoryEntry {
  month: string;
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  categoryBreakdown: Array<{
    categoryName: string;
    total: number;
    isIncome: boolean;
  }>;
}

export interface AccountBalanceSummary {
  totalBalance: number;
  accounts: Array<{
    name: string;
    accountType: string;
    balance: number;
    currencyCode: string;
  }>;
}

export interface ScheduledTransactionSummary {
  name: string;
  amount: number;
  frequency: string;
  nextDueDate: string;
  categoryName: string | null;
  isIncome: boolean;
  isTransfer: boolean;
}

export interface IncomePatterns {
  monthlyIncome: Array<{
    month: string;
    total: number;
    sourceCount: number;
  }>;
  averageMonthlyIncome: number;
  incomeVariability: number;
}

export interface ForecastAggregates {
  currency: string;
  monthlyHistory: MonthlyHistoryEntry[];
  accountBalances: AccountBalanceSummary;
  scheduledTransactions: ScheduledTransactionSummary[];
  incomePatterns: IncomePatterns;
  recurringCharges: RecurringCharge[];
  today: string;
}

export interface RecurringCharge {
  payeeName: string;
  amounts: number[];
  dates: string[];
  frequency: string;
  currentAmount: number;
  previousAmount: number;
  categoryName: string | null;
}

@Injectable()
export class ForecastAggregatorService {
  private readonly logger = new Logger(ForecastAggregatorService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(ScheduledTransaction)
    private readonly scheduledTransactionRepo: Repository<ScheduledTransaction>,
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
  ) {}

  async computeAggregates(
    userId: string,
    currency: string,
  ): Promise<ForecastAggregates> {
    const now = new Date();
    const today = now.toISOString().substring(0, 10);
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1)
      .toISOString()
      .substring(0, 10);

    const [
      monthlyHistory,
      accountBalances,
      scheduledTransactions,
      incomePatterns,
      recurringCharges,
    ] = await Promise.all([
      this.getMonthlyHistory(userId, twelveMonthsAgo, today),
      this.getAccountBalances(userId),
      this.getActiveScheduledTransactions(userId),
      this.getIncomePatterns(userId, twelveMonthsAgo, today),
      this.getRecurringCharges(userId, twelveMonthsAgo, today),
    ]);

    return {
      currency,
      monthlyHistory,
      accountBalances,
      scheduledTransactions,
      incomePatterns,
      recurringCharges,
      today,
    };
  }

  private async getMonthlyHistory(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<MonthlyHistoryEntry[]> {
    const rows = await this.transactionRepo
      .createQueryBuilder("t")
      .leftJoin("t.category", "cat")
      .select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
      .addSelect("COALESCE(cat.name, 'Uncategorized')", "categoryName")
      .addSelect("COALESCE(cat.isIncome, false)", "isIncome")
      .addSelect(
        "SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)",
        "income",
      )
      .addSelect(
        "SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)",
        "expenses",
      )
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
      .addGroupBy("cat.name")
      .addGroupBy("cat.isIncome")
      .orderBy("month", "ASC")
      .getRawMany();

    const monthMap = new Map<
      string,
      {
        totalIncome: number;
        totalExpenses: number;
        breakdown: Array<{
          categoryName: string;
          total: number;
          isIncome: boolean;
        }>;
      }
    >();

    for (const row of rows) {
      const existing = monthMap.get(row.month) || {
        totalIncome: 0,
        totalExpenses: 0,
        breakdown: [],
      };
      const income = Number(row.income) || 0;
      const expenses = Number(row.expenses) || 0;
      existing.totalIncome += income;
      existing.totalExpenses += expenses;

      const isIncome = row.isIncome === true || row.isIncome === "true";
      const total = isIncome ? income : expenses;
      if (total > 0) {
        existing.breakdown.push({
          categoryName: row.categoryName,
          total,
          isIncome,
        });
      }

      monthMap.set(row.month, existing);
    }

    return Array.from(monthMap.entries()).map(([month, data]) => ({
      month,
      totalIncome: data.totalIncome,
      totalExpenses: data.totalExpenses,
      netCashFlow: data.totalIncome - data.totalExpenses,
      categoryBreakdown: data.breakdown.sort((a, b) => b.total - a.total),
    }));
  }

  private async getAccountBalances(
    userId: string,
  ): Promise<AccountBalanceSummary> {
    const accounts = await this.accountsService.findAll(userId, false);

    const accountList = accounts.map((a) => ({
      name: a.name,
      accountType: a.accountType,
      balance: Number(a.currentBalance),
      currencyCode: a.currencyCode,
    }));

    const totalBalance = accountList.reduce((sum, a) => sum + a.balance, 0);

    return { totalBalance, accounts: accountList };
  }

  private async getActiveScheduledTransactions(
    userId: string,
  ): Promise<ScheduledTransactionSummary[]> {
    const scheduled = await this.scheduledTransactionRepo.find({
      where: { userId, isActive: true },
      relations: ["category"],
      order: { nextDueDate: "ASC" },
    });

    return scheduled.map((st) => {
      const amount = Number(st.amount);
      const isIncome = st.category?.isIncome === true || amount > 0;

      return {
        name: st.name,
        amount: Math.abs(amount),
        frequency: st.frequency,
        nextDueDate: st.nextDueDate
          ? new Date(st.nextDueDate).toISOString().substring(0, 10)
          : "",
        categoryName: st.category?.name || null,
        isIncome,
        isTransfer: st.isTransfer,
      };
    });
  }

  private async getIncomePatterns(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<IncomePatterns> {
    const rows = await this.transactionRepo
      .createQueryBuilder("t")
      .select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
      .addSelect("SUM(t.amount)", "total")
      .addSelect("COUNT(DISTINCT t.payeeName)", "sourceCount")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.amount > 0")
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
      .orderBy("month", "ASC")
      .getRawMany();

    const monthlyIncome = rows.map((r) => ({
      month: r.month,
      total: Number(r.total) || 0,
      sourceCount: Number(r.sourceCount) || 0,
    }));

    const totals = monthlyIncome.map((m) => m.total);
    const averageMonthlyIncome =
      totals.length > 0
        ? totals.reduce((sum, t) => sum + t, 0) / totals.length
        : 0;

    let incomeVariability = 0;
    if (totals.length > 1 && averageMonthlyIncome > 0) {
      const variance =
        totals.reduce(
          (sum, t) => sum + Math.pow(t - averageMonthlyIncome, 2),
          0,
        ) / totals.length;
      incomeVariability = Math.sqrt(variance) / averageMonthlyIncome;
    }

    return { monthlyIncome, averageMonthlyIncome, incomeVariability };
  }

  private async getRecurringCharges(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<RecurringCharge[]> {
    const rows = await this.transactionRepo
      .createQueryBuilder("t")
      .leftJoin("t.category", "cat")
      .select("COALESCE(t.payeeName, 'Unknown')", "payeeName")
      .addSelect("COALESCE(cat.name, 'Uncategorized')", "categoryName")
      .addSelect(
        "ARRAY_AGG(ABS(t.amount) ORDER BY t.transactionDate ASC)",
        "amounts",
      )
      .addSelect(
        "ARRAY_AGG(TO_CHAR(t.transactionDate, 'YYYY-MM-DD') ORDER BY t.transactionDate ASC)",
        "dates",
      )
      .addSelect("COUNT(*)", "txnCount")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.amount < 0")
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .andWhere("t.payeeName IS NOT NULL")
      .groupBy("t.payeeName")
      .addGroupBy("cat.name")
      .having("COUNT(*) >= 3")
      .orderBy("COUNT(*)", "DESC")
      .getRawMany();

    return rows
      .map((r) => {
        const amounts: number[] = (r.amounts || []).map(Number);
        const dates: string[] = r.dates || [];
        const frequency = this.detectFrequency(dates);
        const currentAmount =
          amounts.length > 0 ? amounts[amounts.length - 1] : 0;
        const previousAmount =
          amounts.length > 1 ? amounts[amounts.length - 2] : currentAmount;

        return {
          payeeName: r.payeeName,
          amounts,
          dates,
          frequency,
          currentAmount,
          previousAmount,
          categoryName: r.categoryName,
        };
      })
      .filter((r) => r.frequency !== "irregular");
  }

  private detectFrequency(dates: string[]): string {
    if (dates.length < 3) return "irregular";

    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const d1 = new Date(dates[i - 1]);
      const d2 = new Date(dates[i]);
      gaps.push(
        Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)),
      );
    }

    const avgGap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
    const variance =
      gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev > avgGap * 0.4) return "irregular";

    if (avgGap >= 5 && avgGap <= 10) return "weekly";
    if (avgGap >= 12 && avgGap <= 18) return "biweekly";
    if (avgGap >= 25 && avgGap <= 35) return "monthly";
    if (avgGap >= 80 && avgGap <= 100) return "quarterly";
    if (avgGap >= 350 && avgGap <= 380) return "yearly";

    return "irregular";
  }
}
